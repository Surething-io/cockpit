/**
 * Grok's answer to the title dialog's "suggest a title", on the session's own model.
 *
 * ACP has no ephemeral session, so the prompt runs in a session opened in a throwaway
 * directory, and both that directory and the native session Grok wrote for it are removed
 * afterwards. Nothing is written through Cockpit's Grok transcript store, so the session
 * never appears in Cockpit's lists even while it exists. The real session is never loaded:
 * a live run on it holds its native files, and this must not contend with that.
 */
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getSessionFilePath, readJsonFile, sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { grokNativeSessionPath } from '../../effect/grokNativeSessionLive';
import { GrokAcpClient, GrokRpcError, object, type AcpObject } from './grokAcp/client';
import { grokCompletion } from './grokAcp/events';
import type { TitleSuggestionRequest } from './types';

export interface GrokTitleOptions { binary?: string; args?: string[]; settingsPath?: string }

const REQUEST_TIMEOUT_MS = 30_000;

async function configuredBinary(settingsPath: string | undefined): Promise<string | undefined> {
  if (!settingsPath) return undefined;
  const text = await readFile(settingsPath, 'utf8').catch(() => '{}');
  const grok = object(object(JSON.parse(text)).grok);
  return typeof grok.binaryPath === 'string' && grok.binaryPath.trim() ? grok.binaryPath.trim() : undefined;
}

export async function suggestGrokTitle(
  { cwd, sessionId, prompt, signal }: TitleSuggestionRequest,
  options: GrokTitleOptions = {},
): Promise<string> {
  const scratch = await mkdtemp(join(tmpdir(), 'cockpit-grok-title-'));
  let nativeId: string | undefined;
  let text = '';
  let v2 = false;
  const promptId = randomUUID();
  let settle: (error?: Error) => void = () => {};
  const done = new Promise<Error | undefined>((resolve) => { settle = resolve; });
  const isUpdate = (method: string) => method === 'session/update' || /^_?x\.ai\/(session_notification|session\/update|session\/prompt_complete)$/.test(method);

  const client = new GrokAcpClient({
    binary: options.binary ?? await configuredBinary(options.settingsPath),
    args: options.args,
    cwd: scratch,
    env: (() => { const env = sanitizedSpawnEnv({}); delete env.XAI_API_KEY; return env; })(),
    onNotification: ({ method, params }) => {
      if (!nativeId || params.sessionId !== nativeId || !isUpdate(method)) return;
      const update = object(params.update);
      if (update.sessionUpdate === 'agent_message_chunk') {
        const content = object(update.content);
        if (content.type === 'text' && typeof content.text === 'string') text += content.text;
      }
      const completion = grokCompletion(params, promptId, v2);
      if (!completion) return;
      const reason = completion.stop_reason ?? completion.stopReason;
      settle(reason === 'error' || completion.error
        ? new Error(String(completion.agent_result ?? completion.agentResult ?? completion.error ?? 'Grok prompt failed'))
        : undefined);
    },
    onClosed: (error) => settle(error),
    // A title needs no tools; refuse anything Grok asks for.
    onRequest: () => ({ outcome: { outcome: 'cancelled' } }),
  });
  // Cancellation must end EVERY phase at once — the handshake, auth, session/new, set_model
  // and the prompt — and take the child down with it, not wait for the next await to notice.
  const cancelled = new Error('Title suggestion was cancelled');
  let rejectAborted: (error: Error) => void = () => {};
  const aborted = new Promise<never>((_, reject) => { rejectAborted = reject; });
  aborted.catch(() => {}); // observed by whichever race is pending; never unhandled
  const stop = () => {
    settle(cancelled);
    rejectAborted(cancelled);
    client.dispose(true);
  };
  signal.addEventListener('abort', stop, { once: true });
  if (signal.aborted) stop();
  const request = (method: string, params: AcpObject): Promise<AcpObject> => {
    if (signal.aborted) return Promise.reject(cancelled);
    let timer: ReturnType<typeof setTimeout> | undefined;
    return Promise.race([
      client.request(method, params),
      aborted,
      new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error(`Grok ACP ${method} timed out`)), REQUEST_TIMEOUT_MS); }),
    ]).finally(() => clearTimeout(timer));
  };
  try {
    const info = { name: 'cockpit', version: '1' };
    const initialized = await request('initialize', {
      protocolVersion: 2, info, capabilities: {}, clientInfo: info,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      _meta: { clientType: 'extension' },
    });
    v2 = 'info' in initialized;
    const open = () => request('session/new', { cwd: scratch, mcpServers: [] });
    const opened = await open().catch(async (error: unknown) => {
      if (!(error instanceof GrokRpcError) || error.code !== -32000) throw error;
      await request(v2 ? 'auth/login' : 'authenticate', { methodId: 'cached_token' });
      return open();
    });
    nativeId = typeof opened.sessionId === 'string' ? opened.sessionId : undefined;
    if (!nativeId) throw new Error('Grok ACP returned no session id');
    const prefs = await readJsonFile<{ grokModels?: Record<string, string> }>(getSessionFilePath(cwd), {});
    const model = prefs.grokModels?.[sessionId];
    if (model && model !== 'grok-build') {
      await request(v2 ? 'session/set_config_option' : 'session/set_model', v2
        ? { sessionId: nativeId, configId: 'model', value: model }
        : { sessionId: nativeId, modelId: model });
    }
    if (signal.aborted) throw cancelled;
    void client.request('session/prompt', { sessionId: nativeId, prompt: [{ type: 'text', text: prompt }], _meta: { promptId, requestId: promptId } })
      .then((response) => { if (!v2 && typeof response.stopReason === 'string') settle(); }, (error: unknown) => settle(error instanceof Error ? error : new Error(String(error))));
    const failure = await done;
    if (failure) throw failure;
    return text;
  } finally {
    signal.removeEventListener('abort', stop);
    if (nativeId) {
      try { client.notify('session/cancel', { sessionId: nativeId }); } catch { /* already closed */ }
    }
    client.dispose();
    await Promise.race([client.exited, new Promise((resolve) => setTimeout(resolve, 3_000))]);
    client.dispose(true);
    await rm(scratch, { recursive: true, force: true });
    if (nativeId) await rm(grokNativeSessionPath(scratch, nativeId), { recursive: true, force: true });
  }
}
