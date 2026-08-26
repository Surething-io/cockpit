import { query } from '@anthropic-ai/claude-agent-sdk';
import type { RunCtx, ImageData } from '../types';

type SdkOptions = Record<string, unknown>;

type ContentBlock =
  | { type: 'text'; text: string }
  | { type: 'image'; source: { type: 'base64'; media_type: ImageData['media_type']; data: string } };

/** Build the SDK options for one attempt. `abort` is the controller for THIS attempt (the loop
 *  creates a fresh one per compaction retry and forwards ctx.signal into it). Engine-specific
 *  knobs (env, permissionMode, CLAUDE_CONFIG_DIR, plan canUseTool) live in here. `resume` is the
 *  session id to resume (undefined on first attempt for a new session).
 *
 *  `isRetry` marks a compaction retry, which the loop always drives with `resume` (added after
 *  this returns). Builders that would otherwise emit `sessionId` must skip it then: the SDK
 *  rejects `sessionId` together with `resume` unless `forkSession` is also set. */
export type BuildSdkOptions = (
  abort: AbortController,
  resume: string | undefined,
  isRetry: boolean,
) => SdkOptions;

const MAX_COMPACTION_RETRIES = 1;

/** Forward the CLI's stderr into the server log.
 *
 *  The SDK pipes the child's stderr ONLY when `options.stderr` is set — otherwise it spawns with
 *  stdio[2]='ignore' and throws that output away, so every CLI-side failure (unknown flag after a
 *  version bump, libc mismatch, outright crash) reaches us as a bare
 *  "Claude Code process exited with code 1" with the actual reason already discarded.
 *
 *  Forwarding verbatim is safe: a healthy run writes nothing to stderr. The per-attempt byte
 *  budget is a flood guard, not an exact cap — it stops on the first chunk past the limit.
 *
 *  Permitted `console.error` under EFFECT.md §0 (subprocess IPC adapter gateway). */
const STDERR_LOG_BUDGET_BYTES = 10_000;

function makeStderrForwarder() {
  let spent = 0;
  return (data: string) => {
    if (spent > STDERR_LOG_BUDGET_BYTES) return;
    spent += data.length;
    const text = data.trimEnd();
    if (text) console.error(`[claude:stderr] ${text}`);
    if (spent > STDERR_LOG_BUDGET_BYTES) console.error('[claude:stderr] … further output suppressed');
  };
}

/** Forward ctx.signal into a fresh AbortController (query() takes an AbortController, not a
 *  signal; each compaction retry needs its own). */
function follow(ctx: RunCtx): AbortController {
  const ac = new AbortController();
  if (ctx.signal.aborted) ac.abort();
  else ctx.signal.addEventListener('abort', () => ac.abort(), { once: true });
  return ac;
}

/**
 * Shared SDK run loop for Anthropic-SDK engines (claude / deepseek).
 *
 * Identical across these engines: build content (text ∪ images) → query() → stream events to
 * the registry → on system.init rekey to the real sessionId → on context compaction (stream
 * ends without a result) re-query with 'continue'. The only engine variance is `buildOptions`
 * (env, permissionMode, config dir), injected by the caller.
 */
export async function runSdkLoop(ctx: RunCtx, buildOptions: BuildSdkOptions): Promise<void> {
  const hasImages = !!(ctx.images && ctx.images.length > 0);

  // Build the first user message content: images first (so the model sees them before text),
  // then text.
  const content: ContentBlock[] = [];
  if (ctx.images) {
    for (const img of ctx.images) {
      content.push({ type: 'image', source: { type: 'base64', media_type: img.media_type, data: img.data } });
    }
  }
  if (ctx.prompt) content.push({ type: 'text', text: ctx.prompt });
  const firstContent: string | ContentBlock[] = hasImages ? content : (ctx.prompt ?? '');

  // Background-task persistence: run every turn over a STREAMING input so the underlying claude
  // process stays alive while `run_in_background` shells (and other backgrounded tasks) are still
  // in flight. The SDK emits `system/task_started` when a task launches and
  // `system/task_notification` when it finishes (verified: foreground subagents also notify,
  // BEFORE their turn's `result`, so they never leave anything pending). We hold the input stream
  // open — the process resident — until every started task has reported back, then close it so the
  // process winds down. With no pending task, the stream closes on the first `result` —
  // behaviourally identical to the old one-shot call. While resident, the SDK proactively delivers
  // a background task's notification and auto-runs a follow-up turn on this same stream (no nudge).
  const pendingTasks = new Set<string>();

  // closeInput() lets the current attempt's input generator return, ending the streaming turn.
  // Held in an outer binding so an abort (user stop) can close whichever gate is live.
  let closeInput: () => void = () => {};
  if (!ctx.signal.aborted) {
    ctx.signal.addEventListener('abort', () => closeInput(), { once: true });
  }

  for (let attempt = 0; attempt <= MAX_COMPACTION_RETRIES; attempt++) {
    let gateClosed = false;
    const gateOpen = new Promise<void>((resolve) => {
      closeInput = () => {
        if (!gateClosed) {
          gateClosed = true;
          resolve();
        }
      };
    });
    if (ctx.signal.aborted) closeInput();

    const isRetry = attempt > 0;
    const firstYield = {
      type: 'user' as const,
      // A compaction retry resumes the same session with 'continue'; the first attempt sends the
      // user turn (text ∪ images).
      message: { role: 'user' as const, content: isRetry ? 'continue' : firstContent },
      parent_tool_use_id: null,
      session_id: ctx.sessionId || `session-${ctx.currentKey()}`,
    };
    const input = (async function* () {
      yield firstYield;
      await gateOpen; // keep the process resident until the turn (and any background tasks) drain
    })();

    const attemptAbort = follow(ctx);
    const resume = isRetry ? ctx.currentKey() : ctx.sessionId;
    const built = isRetry
      ? { ...buildOptions(attemptAbort, resume, true), resume }
      : buildOptions(attemptAbort, ctx.sessionId, false);
    const options = { ...built, stderr: makeStderrForwarder() };

    const response = query({ prompt: input, options });

    let receivedResult = false;
    for await (const message of response) {
      if (ctx.signal.aborted) {
        closeInput();
        break;
      }

      const msg = message as { type?: string; subtype?: string; session_id?: string; task_id?: string };
      // New session: the engine reveals its real sessionId in the system.init event.
      if (msg.type === 'system' && msg.subtype === 'init' && msg.session_id) {
        ctx.rekey(msg.session_id);
      }
      // Track background-task lifecycle to decide when the process may wind down.
      if (msg.type === 'system' && msg.subtype === 'task_started' && msg.task_id) {
        pendingTasks.add(msg.task_id);
      }
      if (msg.type === 'system' && msg.subtype === 'task_notification' && msg.task_id) {
        pendingTasks.delete(msg.task_id);
      }
      if (msg.type === 'result') receivedResult = true;

      ctx.emit(message as { type: string; [k: string]: unknown });

      // Turn produced a result and nothing is still running in the background → close the input so
      // the process winds down. If a task is still pending, stay resident and let the SDK deliver
      // its notification + auto-run the follow-up turn on this stream.
      if (msg.type === 'result' && pendingTasks.size === 0) closeInput();
    }
    closeInput(); // ensure the generator can return even if the stream ended on its own

    if (receivedResult || ctx.signal.aborted) break;

    // Stream ended without a result → likely context compaction; loop re-queries with 'continue'.
  }
}
