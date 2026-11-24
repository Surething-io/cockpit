/**
 * Predicted next user prompt for Codex sessions — the counterpart of the claude
 * CLI's `prompt_suggestion`, which Codex has no equivalent of.
 *
 * Once a turn has completed, the run's own app-server connection forks the
 * thread into an ephemeral copy and asks that copy for the user's likely next
 * message. Measured against codex 0.172.0:
 *  - `thread/fork` with `ephemeral: true` returns in ~20ms, writes no rollout,
 *    does not show up in `thread/list`, and leaves the source thread's turns
 *    and rollout untouched;
 *  - the suggestion turn takes ~6s at `low` effort and reuses most of the
 *    prompt cache (~73% of input cached), so it costs roughly the uncached
 *    remainder plus a few dozen output tokens;
 *  - `turn/interrupt` stops it in ~0.3s.
 *
 * This runs AFTER the run has returned, so the spinner stops at the real end of
 * the turn. That has one hard consequence: the app-server process still holds
 * the source thread's writer lock while it generates. A second process
 * resuming the same thread would be refused (`thread-store conflict`) and fall
 * back to a fresh thread, silently dropping the history. So the next Codex run
 * on a session MUST `await cancelCodexSuggestion(threadId)` before it spawns —
 * cancelling kills the child and waits for it to exit.
 *
 * The ephemeral fork never writes the session's rollout, which is why releasing
 * the orchestrator's writer lease before this finishes is sound.
 */
import { readJsonFile, SETTINGS_FILE } from '@cockpit/shared-utils';
import type { CodexNotification } from './codexAppServer/client';

/** Hard ceiling on one suggestion, startup included. Past it the child is killed. */
export const CODEX_SUGGESTION_TIMEOUT_MS = 15_000;
/** Upper bound on waiting for a killed child to exit. */
const EXIT_WAIT_MS = 5_000;
/** Longest suggestion still shown; a longer reply is the model ignoring the prompt. */
const MAX_SUGGESTION_CHARS = 200;

/** settings.json key; absent means on. */
export const CODEX_SUGGESTION_SETTING = 'codexPromptSuggestions';

export const CODEX_SUGGESTION_PROMPT = [
  'Predict the single next message the user is most likely to send in this conversation.',
  'Reply with ONLY that message, written as the user would type it, in the language the user has been using.',
  'One line, at most 80 characters, no quotes, no preamble. Do not call any tools.',
  'If nothing natural follows, reply with an empty line.',
].join(' ');

/** The slice of `CodexAppServerClient` this needs; narrowed so tests can fake it. */
export interface CodexSuggestionTransport {
  request(method: string, params?: unknown): Promise<Record<string, unknown>>;
  dispose(aborted?: boolean): void;
  readonly exited: Promise<void>;
}

interface PendingSuggestion {
  readonly done: Promise<void>;
  cancel(): void;
}

/** In flight, by source thread id — which is the session id the next run resumes. */
const pending = new Map<string, PendingSuggestion>();

/**
 * Stop any suggestion still generating for this thread and wait until its
 * app-server child has exited. Resolves at once when there is none.
 */
export async function cancelCodexSuggestion(threadId: string | undefined): Promise<void> {
  if (!threadId) return;
  const entry = pending.get(threadId);
  if (!entry) return;
  entry.cancel();
  await entry.done;
}

/** Reads the toggle fresh each time: settings change while the server runs. */
export async function codexSuggestionsEnabled(): Promise<boolean> {
  const settings = await readJsonFile<Record<string, unknown>>(SETTINGS_FILE, {}).catch(() => ({}) as Record<string, unknown>);
  return settings[CODEX_SUGGESTION_SETTING] !== false;
}

/**
 * Normalise the model's reply into something fit for the composer placeholder,
 * or null when it is not a usable single-line prompt.
 */
export function cleanCodexSuggestion(raw: string): string | null {
  const line = raw.split('\n').map((l) => l.trim()).find((l) => l.length > 0);
  if (!line) return null;
  const unquoted = line.replace(/^(["'`“”‘’「」]+)|(["'`“”‘’「」]+)$/g, '').trim();
  if (!unquoted || unquoted.length > MAX_SUGGESTION_CHARS) return null;
  return unquoted;
}

/** Items a plain text reply produces. Anything else is a tool call. */
const TEXT_ITEM_TYPES = new Set(['agentMessage', 'reasoning', 'userMessage']);

export interface StartCodexSuggestionOptions {
  transport: CodexSuggestionTransport;
  /** The source thread; also the key `cancelCodexSuggestion` is called with. */
  threadId: string;
  publish(suggestion: string): void;
  /** Called once the work has settled and the child is gone (or the exit wait gave up). */
  onSettled?: () => void;
  /** Injected for tests. */
  enabled?: () => Promise<boolean>;
  timeoutMs?: number;
}

/**
 * Take ownership of `transport` and generate one suggestion in the background.
 * Returns the notification handler the caller must route EVERY further
 * notification from this connection to; the transport is always disposed by
 * the time the work settles, whether it published, failed, timed out or was
 * cancelled.
 */
export function startCodexSuggestion(opts: StartCodexSuggestionOptions): (n: CodexNotification) => void {
  const { transport, threadId, publish } = opts;
  let forkId: string | null = null;
  let cancelled = false;
  let text = '';
  let settleTurn: (outcome: 'completed' | 'abandoned') => void = () => {};
  const turnDone = new Promise<'completed' | 'abandoned'>((resolve) => { settleTurn = resolve; });

  const onNotification = (n: CodexNotification): void => {
    const params = n.params ?? {};
    if (!forkId || params.threadId !== forkId) return;
    if (n.method === 'item/started' || n.method === 'item/completed') {
      const item = params.item as { type?: unknown; text?: unknown } | undefined;
      const type = typeof item?.type === 'string' ? item.type : '';
      if (type && !TEXT_ITEM_TYPES.has(type)) {
        // The fork runs read-only, but a suggestion that wants a tool is not a suggestion.
        settleTurn('abandoned');
        return;
      }
      if (n.method === 'item/completed' && type === 'agentMessage' && typeof item?.text === 'string') {
        text += item.text;
      }
      return;
    }
    if (n.method === 'turn/completed') {
      const status = (params.turn as { status?: unknown } | undefined)?.status;
      settleTurn(status === 'completed' ? 'completed' : 'abandoned');
    }
  };

  // Killing the child rejects every pending request and resolves `exited`, so
  // one dispose unblocks whichever await the work is parked on.
  const stop = () => {
    cancelled = true;
    transport.dispose(true);
  };

  const done = (async () => {
    const timer = setTimeout(stop, opts.timeoutMs ?? CODEX_SUGGESTION_TIMEOUT_MS);
    try {
      if (!(await (opts.enabled ?? codexSuggestionsEnabled)()) || cancelled) return;
      const fork = await transport.request('thread/fork', {
        threadId,
        ephemeral: true,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        excludeTurns: true,
      });
      const id = (fork.thread as { id?: unknown } | undefined)?.id;
      if (typeof id !== 'string' || cancelled) return;
      forkId = id;
      await transport.request('turn/start', {
        threadId: id,
        input: [{ type: 'text', text: CODEX_SUGGESTION_PROMPT, text_elements: [] }],
        effort: 'low',
      });
      const outcome = await Promise.race([turnDone, transport.exited.then(() => 'abandoned' as const)]);
      if (outcome !== 'completed' || cancelled) return;
      const suggestion = cleanCodexSuggestion(text);
      if (suggestion) publish(suggestion);
    } catch {
      // Best effort by design: a missing suggestion is never worth an error.
    } finally {
      clearTimeout(timer);
      transport.dispose(true);
      let exitTimer: ReturnType<typeof setTimeout> | undefined;
      await Promise.race([
        transport.exited,
        new Promise<void>((resolve) => { exitTimer = setTimeout(resolve, EXIT_WAIT_MS); }),
      ]);
      clearTimeout(exitTimer);
      opts.onSettled?.();
    }
  })();

  // A newer suggestion for the same thread cannot exist (the next run cancels
  // first), but guard the delete so a stale entry never removes a live one.
  const entry: PendingSuggestion = { done, cancel: stop };
  pending.set(threadId, entry);
  void done.finally(() => {
    if (pending.get(threadId) === entry) pending.delete(threadId);
  });

  return onNotification;
}
