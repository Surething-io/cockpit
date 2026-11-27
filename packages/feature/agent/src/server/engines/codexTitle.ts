/**
 * Codex's answer to the title dialog's "suggest a title", on the session's own model.
 *
 * A fresh `codex app-server` opens an EPHEMERAL thread — no rollout is written, it never
 * shows up in `thread/list` (see codexSuggestion for the measurements) — runs one read-only
 * turn, and exits. The session's own thread is never resumed, so its writer lock (held by a
 * live run, or by another Codex client) is irrelevant here.
 */
import { sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { CodexAppServerClient, type CodexNotification } from './codexAppServer/client';
import { suggestionModel } from './sessionModel';
import type { TitleSuggestionRequest } from './types';

const EXIT_WAIT_MS = 5_000;

export async function suggestCodexTitle({ cwd, sessionId, prompt, signal }: TitleSuggestionRequest): Promise<string> {
  let threadId: string | undefined;
  let text = '';
  let settle: (outcome: 'completed' | 'failed') => void = () => {};
  const turnDone = new Promise<'completed' | 'failed'>((resolve) => { settle = resolve; });
  const onNotification = (n: CodexNotification): void => {
    const params = n.params ?? {};
    if (!threadId || params.threadId !== threadId) return;
    if (n.method === 'item/completed') {
      const item = params.item as { type?: unknown; text?: unknown } | undefined;
      if (item?.type === 'agentMessage' && typeof item.text === 'string') text += item.text;
    } else if (n.method === 'turn/completed') {
      const status = (params.turn as { status?: unknown } | undefined)?.status;
      settle(status === 'completed' ? 'completed' : 'failed');
    }
  };

  const client = CodexAppServerClient.start({
    env: sanitizedSpawnEnv({}),
    cwd,
    onNotification,
    // Permitted `console.error` under EFFECT.md §0 (subprocess IPC adapter gateway).
    onStderr: (line) => console.error(`[codex title] ${line}`),
  });
  const stop = () => client.dispose(true);
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  try {
    await client.request('initialize', {
      clientInfo: { name: 'cockpit', title: 'cockpit', version: '1' },
      capabilities: { experimentalApi: true },
    });
    client.notify('initialized');
    const model = await suggestionModel('codex', cwd, sessionId);
    const started = await client.request('thread/start', {
      cwd,
      ephemeral: true,
      sandbox: 'read-only',
      approvalPolicy: 'never',
      ...(model && { model }),
    });
    threadId = (started.thread as { id?: unknown } | undefined)?.id as string | undefined;
    if (typeof threadId !== 'string') throw new Error('codex app-server returned no thread id');
    await client.request('turn/start', {
      threadId,
      input: [{ type: 'text', text: prompt, text_elements: [] }],
      effort: 'low',
    });
    const outcome = await Promise.race([turnDone, client.exited.then(() => 'failed' as const)]);
    if (signal.aborted) throw new Error('Title suggestion was cancelled');
    if (outcome !== 'completed') throw new Error('Codex did not finish the title suggestion');
    return text;
  } finally {
    signal.removeEventListener('abort', stop);
    client.dispose(true);
    let timer: ReturnType<typeof setTimeout> | undefined;
    await Promise.race([client.exited, new Promise<void>((resolve) => { timer = setTimeout(resolve, EXIT_WAIT_MS); })]);
    clearTimeout(timer);
  }
}
