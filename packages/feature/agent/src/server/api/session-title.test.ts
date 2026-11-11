import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cockpit-title-api-'));
process.env.COCKPIT_HOME = join(root, 'cockpit');
process.env.HOME = root;
const sessions = new Map<string, string>();
const engines = new Map<string, string>();
const activeSessions = vi.hoisted(() => new Set<string>());
vi.mock('../sessionRunHub', async (original) => ({
  ...await original<typeof import('../sessionRunHub')>(),
  isRunActive: (id: string) => activeSessions.has(id),
}));
vi.mock('./session/sessionStore', async (original) => ({
  ...await original<typeof import('./session/sessionStore')>(),
  resolveSessionPath: async (_cwd: string, id: string) => sessions.has(id) ? { engine: engines.get(id) ?? 'claude', sessionPath: sessions.get(id)! } : null,
}));
let titlePOST: typeof import('./session-title').POST;
let detailPOST: typeof import('./session-by-path').POST;
let pinGET: typeof import('../../../../../../src/app/api/pinned-sessions/route').GET;
let pinPOST: typeof import('../../../../../../src/app/api/pinned-sessions/route').POST;
let projectGET: typeof import('../../../../../../src/app/api/project-state/route').GET;
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
  ({ GET: projectGET } = await import('../../../../../../src/app/api/project-state/route'));
  recent = await import('../state/globalState');
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = (body: unknown) => new Request('http://localhost/api/session-title', { method: 'POST', body: JSON.stringify(body) });
const identity = () => ({ cwd: root, sessionId: 'title-api-session' });

describe('session title API and projections', () => {
  it('returns cached labels with the session list on repeated page loads without reading transcripts', async () => {
    const { Effect } = await import('effect');
    const { getSessionFilePath, writeJsonFile } = await import('@cockpit/shared-utils');
    const { refreshSessionTitle } = await import('../../effect/sessionTitles');
    const cwd = join(root, 'bootstrap-project');
    const ids = ['bootstrap-one', 'bootstrap-two'];
    for (const [index, id] of ids.entries()) {
      await Effect.runPromise(refreshSessionTitle(cwd, id, 'claude', Effect.succeed(`Cached subject ${index}`)));
    }
    await writeJsonFile(getSessionFilePath(cwd), { sessions: ids, activeSessionId: ids[0] });
    const source = vi.spyOn(await import('../../effect/logicalTranscript'), 'readLogicalTranscript');
    const lookup = vi.spyOn(await import('./session/sessionStore'), 'resolveSessionPath');
    try {
      for (let i = 0; i < 3; i++) {
        const response = await projectGET(new Request(`http://localhost/api/project-state?cwd=${encodeURIComponent(cwd)}`));
        expect(response.status).toBe(200);
        const state = await response.json();
        expect(state.sessions).toEqual(ids);
        expect(state.sessionTitles.map((info: { title: string }) => info.title)).toEqual(['Cached subject 0', 'Cached subject 1']);
      }
      expect(source).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
    } finally { source.mockRestore(); lookup.mockRestore(); }
  });

  it('serves persisted titles without transcript IO, refreshes and broadcasts only changes, and keeps cache on failure', async () => {
    const sessionId = 'cached-title-api';
    const file = join(root, `${sessionId}.jsonl`);
    const prompt = JSON.stringify({ type: 'user', sessionId, cwd: root, message: { role: 'user', content: 'Original subject' } }) + '\n';
    writeFileSync(file, prompt);
    sessions.set(sessionId, file);
    const batch = { cwd: root, sessionIds: [sessionId] };
    const cacheRequest = () => titlePOST(request({ ...batch, cachedOnly: true }));
    const source = vi.spyOn(await import('../../effect/logicalTranscript'), 'readLogicalTranscript');
    const lookup = vi.spyOn(await import('./session/sessionStore'), 'resolveSessionPath');
    const shared = globalThis as unknown as { __cockpitGlobalStateClients?: Set<{ readyState: number; send: (data: string) => void }> };
    const previousClients = shared.__cockpitGlobalStateClients;
    const notifications: string[] = [];
    shared.__cockpitGlobalStateClients = new Set([{ readyState: 1, send: (data) => { notifications.push(data); } }]);
    try {
      expect((await (await cacheRequest()).json()).titles).toEqual([]);
      expect(source).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      const initial = (await (await titlePOST(request(batch))).json()).titles[0];
      expect(initial).toMatchObject({ title: 'Original subject', defaultTitle: 'Original subject' });
      expect(notifications).toHaveLength(1);
      const before = (await (await detailPOST(request({ cwd: root, sessionId }))).json()).fingerprint;
      appendFileSync(file, JSON.stringify({ type: 'ai-title', aiTitle: 'Updated subject' }) + '\n');
      source.mockClear(); lookup.mockClear();
      expect((await (await cacheRequest()).json()).titles).toEqual([initial]);
      expect(source).not.toHaveBeenCalled();
      expect(lookup).not.toHaveBeenCalled();
      const refreshed = (await (await titlePOST(request(batch))).json()).titles[0];
      expect(refreshed).toMatchObject({ title: 'Updated subject', titleRevision: initial.titleRevision + 1 });
      expect((await (await cacheRequest()).json()).titles).toEqual([refreshed]);
      expect(notifications).toHaveLength(2);
      expect(JSON.parse(notifications[1])).toMatchObject({ type: 'session-title-changed', data: refreshed });
      expect((await (await detailPOST(request({ cwd: root, sessionId, ifFingerprint: before }))).json()).title).toBe('Updated subject');
      await titlePOST(request(batch));
      expect(notifications).toHaveLength(2);
      rmSync(file);
      expect((await (await titlePOST(request(batch))).json()).titles).toEqual([]);
      expect((await (await cacheRequest()).json()).titles).toEqual([refreshed]);
    } finally {
      source.mockRestore(); lookup.mockRestore();
      shared.__cockpitGlobalStateClients = previousClients;
    }
  });

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
    expect(renamed).toMatchObject({ title: 'New task name', defaultTitle: 'Native first prompt', customTitle: 'New task name', titleRevision: before.titleRevision + 1 });
    const after = await (await detailPOST(request({ ...identity(), ifFingerprint: before.fingerprint }))).json();
    expect(after.notModified).toBeUndefined();
    expect(after.title).toBe('New task name');
    expect((await (await detailPOST(request({ ...identity(), ifFingerprint: after.fingerprint }))).json()).notModified).toBe(true);
    const reset = await (await titlePOST(request({ ...identity(), customTitle: null }))).json();
    expect(reset).toMatchObject({ title: 'Native first prompt', customTitle: null, titleRevision: renamed.titleRevision + 1 });
    expect((await (await detailPOST(request({ ...identity(), ifFingerprint: after.fingerprint }))).json()).title).toBe('Native first prompt');
  });
  it('enriches the running snapshot even when transcript preview is skipped', async () => {
    const { sessionId } = identity();
    await titlePOST(request({ ...identity(), customTitle: 'Running task' }));
    await recent.updateGlobalState(root, sessionId, 'loading', 'Cached prompt', 'Latest user message');
    activeSessions.add(sessionId);
    try {
      const snapshot = await recent.getGlobalSessionsSnapshot();
      expect(snapshot.find((s) => s.sessionId === sessionId)).toMatchObject({ status: 'loading', title: 'Running task', defaultTitle: 'Native first prompt' });
    } finally {
      activeSessions.delete(sessionId);
    }
  });
  it('isolates a failed running transcript and preserves custom titles and healthy rows', async () => {
    const { SessionManager } = await import('@earendil-works/pi-coding-agent');
    const { getPiSessionsDir } = await import('@cockpit/shared-utils');
    const sessionId = 'unreadable-running-session';
    const manager = SessionManager.create(root, getPiSessionsDir(root), { id: sessionId });
    manager.appendModelChange('kimi', 'test');
    manager.appendMessage({ role: 'user', content: 'Native subject', timestamp: Date.now() });
    const file = manager.getSessionFile()!;
    sessions.set(sessionId, file);
    engines.set(sessionId, 'kimi');
    await titlePOST(request({ cwd: root, sessionId, customTitle: 'Keep custom subject' }));
    await recent.updateGlobalState(root, sessionId, 'loading', 'Cached subject', 'Current prompt');
    await recent.updateGlobalState(root, identity().sessionId, 'normal');
    const bytes = readFileSync(file);
    writeFileSync(file, 'Invalid native Pi header\n');
    activeSessions.add(sessionId);
    try {
      const snapshot = await recent.getGlobalSessionsSnapshot();
      expect(snapshot.find((s) => s.sessionId === sessionId)).toMatchObject({ title: 'Keep custom subject', engine: 'kimi', status: 'loading', lastUserMessage: 'Current prompt' });
      expect(snapshot.some((s) => s.sessionId === identity().sessionId)).toBe(true);
    } finally {
      activeSessions.delete(sessionId);
      writeFileSync(file, bytes);
    }
  });
  it('keeps a Codex native title while running without a persisted title', async () => {
    const sessionId = 'running-codex-title';
    const file = join(root, `${sessionId}.jsonl`);
    writeFileSync(file, [
      { type: 'session_meta', payload: { id: sessionId, cwd: root } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions' }] } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Design nested context trees' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    sessions.set(sessionId, file);
    engines.set(sessionId, 'codex');
    await recent.updateGlobalState(root, sessionId, 'loading', undefined, 'Continue implementation', 'codex');
    activeSessions.add(sessionId);
    try {
      const snapshot = await recent.getGlobalSessionsSnapshot();
      expect(snapshot.find((s) => s.sessionId === sessionId)).toMatchObject({
        status: 'loading', title: 'Design nested context trees', defaultTitle: 'Design nested context trees',
        customTitle: null, lastUserMessage: 'Continue implementation',
      });
    } finally {
      activeSessions.delete(sessionId);
    }
    const completed = await recent.getGlobalSessionsSnapshot();
    expect(completed.find((s) => s.sessionId === sessionId)?.title).toBe('Design nested context trees');
  });
  it.each([
    { name: 'image-text', content: [
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/title.png">' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAAA' },
      { type: 'input_text', text: '</image>' },
      { type: 'input_text', text: 'Explain this diagram' },
    ], expected: 'Explain this diagram' },
    { name: 'image-only', content: [{ type: 'input_image', image_url: 'data:image/png;base64,AAAA' }], expected: '[Image]' },
    { name: 'long-text', content: [{ type: 'input_text', text: 'a'.repeat(100) }], expected: 'a'.repeat(80) },
    { name: 'slash-command', content: [{ type: 'input_text', text: '/qa' }], expected: '/qa' },
  ])('uses the same Codex $name title in detail, metadata and snapshots', async ({ name, content, expected }) => {
    const sessionId = `consistent-codex-${name}`;
    const file = join(root, `${sessionId}.jsonl`);
    writeFileSync(file, [
      { type: 'session_meta', payload: { id: sessionId, cwd: root } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content } },
      { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Follow-up message' }] } },
    ].map((line) => JSON.stringify(line)).join('\n') + '\n');
    sessions.set(sessionId, file);
    engines.set(sessionId, 'codex');
    const identity = { cwd: root, sessionId };
    expect((await (await titlePOST(request(identity))).json()).defaultTitle).toBe(expected);
    expect((await (await detailPOST(request(identity))).json()).defaultTitle).toBe(expected);
    expect((await recent.getSessionPreview(root, sessionId)).defaultTitle).toBe(expected);
    await recent.updateGlobalState(root, sessionId, 'loading', undefined, 'Latest prompt', 'codex');
    activeSessions.add(sessionId);
    try {
      expect((await recent.getGlobalSessionsSnapshot()).find((s) => s.sessionId === sessionId)?.title).toBe(expected);
    } finally {
      activeSessions.delete(sessionId);
    }
    expect((await recent.getGlobalSessionsSnapshot()).find((s) => s.sessionId === sessionId)?.title).toBe(expected);
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
  it.each([
    { isMeta: true },
    { isCompactSummary: true },
    { origin: { kind: 'task-notification' } },
    { origin: { kind: 'system' } },
  ])('keeps Claude command titles and ignores injected metadata %j', async (injection) => {
    const sessionId = `claude-command-title-${Buffer.from(JSON.stringify(injection)).toString('hex')}`;
    const file = join(root, `${sessionId}.jsonl`);
    writeFileSync(file, [
      { type: 'user', ...injection, message: { role: 'user', content: 'Injected skill instructions' } },
      { type: 'user', message: { role: 'user', content: '<command-name>/qa</command-name>' } },
      { type: 'user', message: { role: 'user', content: 'Design the session title feature' } },
    ].map((line) => JSON.stringify({ ...line, sessionId, cwd: root })).join('\n') + '\n');
    sessions.set(sessionId, file);
    const identity = { cwd: root, sessionId };
    const expected = '/qa Design the session title feature';
    expect((await (await titlePOST(request(identity))).json()).defaultTitle).toBe(expected);
    expect((await (await detailPOST(request(identity))).json()).defaultTitle).toBe(expected);
    expect((await recent.getSessionPreview(root, sessionId)).defaultTitle).toBe(expected);
  });
  it.each(['claude', 'codex'] as const)('preserves the %s title throughout an independent task', async (engine) => {
    const sessionId = `independent-title-${engine}`;
    const file = join(root, `${sessionId}.jsonl`);
    const user = (text: string) => engine === 'codex'
      ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
      : { type: 'user', sessionId, cwd: root, message: { role: 'user', content: text } };
    const meta = engine === 'codex' ? [{ type: 'session_meta', payload: { id: sessionId, cwd: root } }] : [];
    writeFileSync(file, [...meta, user('Original session subject')].map((line) => JSON.stringify(line)).join('\n') + '\n');
    sessions.set(sessionId, file);
    engines.set(sessionId, engine);
    const identity = { cwd: root, sessionId };
    expect((await (await titlePOST(request(identity))).json()).title).toBe('Original session subject');
    const claude = await import('../engines/shared/noHistoryTranscript');
    const codex = await import('../engines/shared/noHistoryRollout');
    const stash = engine === 'codex' ? codex.stashCodexRollout : claude.stashTranscript;
    const merge = engine === 'codex' ? codex.mergeStashedCodexRollout : claude.mergeStashedTranscript;
    expect(stash(file)).toBe(true);
    await recent.updateGlobalState(root, sessionId, 'loading', undefined, 'Independent task prompt', engine);
    activeSessions.add(sessionId);
    try {
      // Claude has no current file yet; Codex has only its session_meta stub.
      expect((await (await titlePOST(request(identity))).json()).defaultTitle).toBe('Original session subject');
      appendFileSync(file, JSON.stringify(user('Independent task prompt')) + '\n');
      expect((await (await titlePOST(request(identity))).json()).defaultTitle).toBe('Original session subject');
      expect((await (await detailPOST(request(identity))).json()).defaultTitle).toBe('Original session subject');
      expect((await recent.getSessionPreview(root, sessionId)).defaultTitle).toBe('Original session subject');
      expect((await recent.getGlobalSessionsSnapshot()).find((s) => s.sessionId === sessionId)?.title).toBe('Original session subject');
      const { runWithTranscriptIndex } = await import('../../effect/transcriptIndexLive');
      const before = await runWithTranscriptIndex((index) => index.counters);
      await recent.getDefaultSessionTitle(root, sessionId);
      await recent.getDefaultSessionTitle(root, sessionId);
      const after = await runWithTranscriptIndex((index) => index.counters);
      expect(after.bytesParsed).toBe(before.bytesParsed);
      await titlePOST(request({ ...identity, customTitle: 'Custom subject' }));
      expect((await recent.getGlobalSessionsSnapshot()).find((s) => s.sessionId === sessionId)?.title).toBe('Custom subject');
      expect((await (await titlePOST(request({ ...identity, customTitle: null }))).json()).title).toBe('Original session subject');
    } finally {
      merge(file);
      activeSessions.delete(sessionId);
    }
    expect((await recent.getGlobalSessionsSnapshot()).find((s) => s.sessionId === sessionId)?.title).toBe('Original session subject');
  });
  it('resolves a native Claude session while only its stashed history exists', async () => {
    const { getClaudeSessionPath } = await import('@cockpit/shared-utils');
    const store = await vi.importActual<typeof import('./session/sessionStore')>('./session/sessionStore');
    const { noHistoryStashPath } = await import('../engines/shared/noHistoryTranscript');
    const file = getClaudeSessionPath(root, 'stashed-only-claude');
    const stash = noHistoryStashPath(file);
    mkdirSync(join(stash, '..'), { recursive: true });
    writeFileSync(stash, JSON.stringify({ type: 'user', message: { role: 'user', content: 'Original subject' } }) + '\n');
    expect(await store.resolveSessionPath(root, 'stashed-only-claude')).toEqual({ sessionPath: file, engine: 'claude' });
  });
});
