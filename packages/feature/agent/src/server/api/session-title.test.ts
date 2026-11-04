import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cockpit-title-api-'));
process.env.COCKPIT_HOME = join(root, 'cockpit');
const sessions = new Map<string, string>();
const engines = new Map<string, string>();
vi.mock('./session/sessionStore', async (original) => ({
  ...await original<typeof import('./session/sessionStore')>(),
  resolveSessionPath: async (_cwd: string, id: string) => sessions.has(id) ? { engine: engines.get(id) ?? 'claude', sessionPath: sessions.get(id)! } : null,
}));
let titlePOST: typeof import('./session-title').POST;
let detailPOST: typeof import('./session-by-path').POST;
let pinGET: typeof import('../../../../../../src/app/api/pinned-sessions/route').GET;
let pinPOST: typeof import('../../../../../../src/app/api/pinned-sessions/route').POST;
let recent: typeof import('../state/globalState');
beforeAll(async () => {
  mkdirSync(join(root, 'cockpit'), { recursive: true });
  const id = 'title-api-session';
  const file = join(root, `${id}.jsonl`);
  writeFileSync(file, JSON.stringify({ type: 'user', uuid: 'u1', sessionId: id, cwd: root, message: { role: 'user', content: 'Native first prompt' } }) + '\n');
  sessions.set(id, file);
  writeFileSync(join(root, 'cockpit', 'pinned-sessions.json'), JSON.stringify([{ cwd: root, sessionId: id, customTitle: 'Old favorite name' }]));
  ({ POST: titlePOST } = await import('./session-title'));
  ({ POST: detailPOST } = await import('./session-by-path'));
  ({ GET: pinGET, POST: pinPOST } = await import('../../../../../../src/app/api/pinned-sessions/route'));
  recent = await import('../state/globalState');
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = (body: unknown) => new Request('http://localhost/api/session-title', { method: 'POST', body: JSON.stringify(body) });
const identity = () => ({ cwd: root, sessionId: 'title-api-session' });

describe('session title API and projections', () => {
  it('migrates the favorite, returns the same title in detail, and retains it after unpinning', async () => {
    const title = await (await titlePOST(request(identity()))).json();
    expect(title.title).toBe('Old favorite name');
    expect((await (await detailPOST(request(identity()))).json()).title).toBe(title.title);
    expect((await (await pinGET(new Request('http://localhost/api/pinned-sessions'))).json()).sessions[0]).toMatchObject({ title: title.title });
    expect((await pinPOST(request({ sessions: [] }))).status).toBe(200);
    expect((await (await titlePOST(request(identity()))).json()).title).toBe('Old favorite name');
  });
  it('invalidates detail fingerprints on rename and reset without touching the transcript', async () => {
    const before = await (await detailPOST(request(identity()))).json();
    const renamed = await (await titlePOST(request({ ...identity(), customTitle: 'New task name' }))).json();
    expect(renamed).toMatchObject({ title: 'New task name', defaultTitle: 'Native first prompt', customTitle: 'New task name', titleRevision: 1 });
    const after = await (await detailPOST(request({ ...identity(), ifFingerprint: before.fingerprint }))).json();
    expect(after.notModified).toBeUndefined();
    expect(after.title).toBe('New task name');
    expect((await (await detailPOST(request({ ...identity(), ifFingerprint: after.fingerprint }))).json()).notModified).toBe(true);
    const reset = await (await titlePOST(request({ ...identity(), customTitle: null }))).json();
    expect(reset).toMatchObject({ title: 'Native first prompt', customTitle: null, titleRevision: 2 });
    expect((await (await detailPOST(request({ ...identity(), ifFingerprint: after.fingerprint }))).json()).title).toBe('Native first prompt');
  });
  it('enriches the running snapshot even when transcript preview is skipped', async () => {
    const { sessionId } = identity();
    await titlePOST(request({ ...identity(), customTitle: 'Running task' }));
    await recent.updateGlobalState(root, sessionId, 'loading', 'Cached prompt', 'Latest user message');
    const snapshot = await recent.getGlobalSessionsSnapshot();
    expect(snapshot.find((s) => s.sessionId === sessionId)?.title).toBe('Running task');
  });
  it.each(['codex', 'grok', 'kimi'] as const)('renames and resets a native %s session', async (engine) => {
    const { Effect } = await import('effect');
    const sessionId = `native-title-${engine}`;
    let file: string;
    let fallback = `${engine} first prompt`;
    if (engine === 'kimi') {
      const { SessionManager } = await import('@earendil-works/pi-coding-agent');
      const { getPiSessionsDir } = await import('@cockpit/shared-utils');
      const manager = SessionManager.create(root, getPiSessionsDir(root), { id: sessionId });
      manager.appendModelChange('kimi', 'test');
      manager.appendMessage({ role: 'user', content: fallback, timestamp: Date.now() });
      manager.appendSessionInfo('Pi native name');
      file = manager.getSessionFile()!;
      fallback = 'Pi native name';
    } else if (engine === 'grok') {
      const grok = await import('../../effect/grokSessionLive');
      await Effect.runPromise(grok.appendGrokTranscript(root, sessionId, { type: 'user', message: { role: 'user', content: fallback } }));
      file = grok.grokSessionPath(root, sessionId);
    } else {
      file = join(root, `${sessionId}.jsonl`);
      writeFileSync(file, [
        { type: 'session_meta', payload: { id: sessionId, cwd: root } },
        { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: fallback }] } },
      ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    }
    sessions.set(sessionId, file);
    engines.set(sessionId, engine);
    const identity = { cwd: root, sessionId };
    const renamed = await (await titlePOST(request({ ...identity, customTitle: 'Unified name' }))).json();
    expect(renamed).toMatchObject({ title: 'Unified name', defaultTitle: fallback });
    expect((await (await detailPOST(request(identity))).json()).title).toBe('Unified name');
    expect((await (await titlePOST(request({ ...identity, customTitle: null }))).json()).title).toBe(fallback);
  });
  it('rejects invalid input or unknown sessions without creating a title', async () => {
    expect((await titlePOST(request({ ...identity(), customTitle: ' \n ' }))).status).toBe(400);
    expect((await titlePOST(request({ cwd: root, sessionId: 'missing', customTitle: 'Name' }))).status).toBe(404);
    expect((await titlePOST(request({ customTitle: 'Name' }))).status).toBe(400);
  });
});
