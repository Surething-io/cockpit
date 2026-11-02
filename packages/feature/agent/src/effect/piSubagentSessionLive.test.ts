import { mkdtemp, readFile, rm, writeFile, utimes, symlink, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { Effect } from 'effect';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createPiChildSession, finishPiChildSession, listPiChildren, piChildRoot, retainPiChildPartial } from './piSubagentSessionLive';
import { forkPiSession, deletePiTurn } from './piSessionEditLive';
import { cleanupSessions } from './sessionCleanupLive';

let home: string;
let projectDir: string;
let apiPath: string;
const previousHome = process.env.COCKPIT_HOME;
vi.mock('../server/api/session/sessionStore', () => ({
  resolveSessionPath: async (_cwd: string, id: string) => apiPath && id === SessionManager.open(apiPath).getSessionId() ? { sessionPath: apiPath, engine: 'ollama' } : null,
}));
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'pi-child-history-'));
  process.env.COCKPIT_HOME = home;
  const utils = await import('@cockpit/shared-utils');
  projectDir = utils.getPiSessionsDir(home);
});
afterAll(async () => {
  await rm(home, { recursive: true, force: true });
  if (previousHome === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = previousHome;
});
const run = Effect.runPromise;
function assistant(call: string): AssistantMessage {
  return { role: 'assistant', content: [{ type: 'toolCall', id: call, name: 'subagent', arguments: { task: call } }],
    api: 'openai-completions', provider: 'ollama', model: 'test', stopReason: 'toolUse', timestamp: Date.now(),
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
}
async function fixture(id: string) {
  const manager = SessionManager.create(home, projectDir, { id });
  const first = manager.appendMessage({ role: 'user', content: 'first task', timestamp: Date.now() });
  manager.appendMessage(assistant('call-one'));
  const a = await run(createPiChildSession(manager.getSessionFile()!, id, home, {
    id: 'child-a', index: 0, toolUseId: 'call-one', name: 'First child', task: 'task A', model: 'ollama/test',
  }, 'Private dynamic instructions'));
  const child = SessionManager.open(resolve(projectDir, id, a.sessionPath));
  child.appendMessage({ role: 'user', content: 'task A', timestamp: Date.now() });
  child.appendMessage({ ...assistant('child-tool'), content: [{ type: 'text', text: 'Child answer' }], stopReason: 'stop' });
  await run(finishPiChildSession(manager.getSessionFile()!, id, a, 'done'));
  const second = manager.appendMessage({ role: 'user', content: 'second task', timestamp: Date.now() });
  manager.appendMessage(assistant('call-two'));
  await run(createPiChildSession(manager.getSessionFile()!, id, home, {
    id: 'child-b', index: 0, toolUseId: 'call-two', name: 'Second child', task: 'task B', model: 'deepseek/test',
  }, 'Second instructions'));
  return { manager, first, second, a, path: manager.getSessionFile()! };
}
async function request(id: string, body: Record<string, unknown>) {
  const { POST } = await import('../server/api/session-by-path');
  const response = await POST(new Request('http://test.local/api/session-by-path', {
    method: 'POST', body: JSON.stringify({ cwd: home, sessionId: id, toolUseId: 'call-one', ...body }),
  }));
  return { status: response.status, data: await response.json() };
}

it('loads native child history via parent/call coordinates, including instructions and conditional reads', async () => {
  const f = await fixture('history-api'); apiPath = f.path;
  const first = await request('history-api', {});
  expect(first.status).toBe(200);
  expect(JSON.stringify(first.data.messages)).toContain('Child answer');
  expect(JSON.stringify(first.data.messages)).toContain('Private dynamic instructions');
  expect(first.data.children).toEqual([{ id: 'child-a', name: 'First child', model: 'ollama/test', status: 'done' }]);
  const cached = await request('history-api', { ifFingerprint: first.data.fingerprint });
  expect(cached.data.notModified).toBe(true);
  // Metadata still advances when the selected transcript has not changed.
  const sibling = await run(createPiChildSession(f.path, 'history-api', home, {
    id: 'child-c', index: 1, toolUseId: 'call-one', name: 'Parallel child', task: 'C', model: 'ollama/other',
  }, 'Third instructions'));
  const changed = await request('history-api', { ifFingerprint: first.data.fingerprint });
  expect(changed.data.notModified).toBe(true);
  expect(changed.data.children).toHaveLength(2);
  expect((await request('history-api', { childSessionId: sibling.id })).data.childSessionId).toBe(sibling.id);
  expect((await request('history-api', { childSessionId: 'child-b' })).status).toBe(404);
  expect((await request('history-api', { childSessionId: '../child-b' })).status).toBe(400);
  const { listPiSessions } = await import('./piSessionLive');
  expect((await run(listPiSessions(home))).map((s) => s.id)).not.toContain('child-a');
});

it('copies only retained child histories for prefix/single forks and prunes deleted turns independently', async () => {
  const f = await fixture('fork-history');
  const single = await run(forkPiSession(f.path, f.second, 'single'));
  const prefix = await run(forkPiSession(f.path, f.first, 'prefix'));
  const { findPiSession } = await import('./piSessionLive');
  const singleFile = (await run(findPiSession(home, single!.newSessionId)))!;
  const prefixFile = (await run(findPiSession(home, prefix!.newSessionId)))!;
  expect((await run(listPiChildren(singleFile.path, singleFile.id))).map((c) => c.id)).toEqual(['child-b']);
  expect((await run(listPiChildren(prefixFile.path, prefixFile.id))).map((c) => c.id)).toEqual(['child-a']);
  await run(deletePiTurn(f.path, f.first));
  expect((await run(listPiChildren(f.path, 'fork-history'))).map((c) => c.id)).toEqual(['child-b']);
  const path = resolve(dirname(prefixFile.path), prefixFile.id, f.a.sessionPath);
  expect(await readFile(path, 'utf8')).toContain('Child answer');
  // The copied history remains available after deleting the original parent tree.
  await rm(join(projectDir, 'fork-history'), { recursive: true });
  await rm(f.path);
  expect(await readFile(path, 'utf8')).toContain('Child answer');
});

it('retains fresh/pinned parents with old children and removes expired parents together with artifacts', async () => {
  const fresh = await fixture('fresh-history');
  const expired = await fixture('expired-history');
  const pinned = await fixture('pinned-history');
  const old = new Date(Date.now() - 60 * 86400000);
  const pinFile = join(home, 'pins.json');
  await writeFile(pinFile, JSON.stringify([{ sessionId: 'pinned-history' }]));
  for (const f of [fresh, expired, pinned]) await utimes(join(dirname(f.path), f.manager.getSessionId()), old, old);
  for (const f of [expired, pinned]) await utimes(f.path, old, old);
  await run(cleanupSessions(dirname(projectDir), 30, pinFile));
  expect(await readFile(fresh.path, 'utf8')).toContain('fresh-history');
  expect(await readFile(pinned.path, 'utf8')).toContain('pinned-history');
  expect((await run(listPiChildren(fresh.path, 'fresh-history')))).toHaveLength(2);
  expect((await run(listPiChildren(pinned.path, 'pinned-history')))).toHaveLength(2);
  await expect(readFile(expired.path)).rejects.toMatchObject({ code: 'ENOENT' });
  await expect(readFile(resolve(dirname(expired.path), 'expired-history', expired.a.sessionPath))).rejects.toMatchObject({ code: 'ENOENT' });
});

it('rejects escaped transcript paths and symlinked history roots', async () => {
  const f = await fixture('unsafe-history');
  const root = piChildRoot(f.path, 'unsafe-history');
  const metaFile = join(root, 'child-a', 'meta.json');
  const meta = JSON.parse(await readFile(metaFile, 'utf8'));
  await writeFile(metaFile, JSON.stringify({ ...meta, sessionPath: '../outside.jsonl' }));
  await expect(run(listPiChildren(f.path, 'unsafe-history', 'call-one'))).rejects.toThrow();
  const outside = join(home, 'outside-root');
  await mkdir(outside); await mkdir(join(outside, 'child'));
  await rm(root, { recursive: true });
  await symlink(outside, root);
  await expect(run(listPiChildren(f.path, 'unsafe-history'))).rejects.toThrow('Pi subagent history operation failed');
});

// The same context invariant must hold across every destructive/history-copy path.
it.each(['prefix', 'single', 'delete-first', 'delete-middle', 'delete-last'] as const)(
  'preserves effective edits by retained target across %s', async (operation) => {
    const manager = SessionManager.create(home, projectDir);
    const users: string[] = [], answers: string[] = [];
    for (let i = 0; i < 3; i++) {
      users.push(manager.appendMessage({ role: 'user', content: `user-${i}`, timestamp: Date.now() }));
      answers.push(manager.appendMessage({ ...assistant(`call-${i}`), content: [{ type: 'text', text: `answer-${i}` }], stopReason: 'stop' }));
      manager.appendContextEdit(users[i], { content: `early-${i}` });
    }
    // All targets are edited in the final turn, including earlier turns.
    for (let i = 0; i < 3; i++) {
      manager.appendContextEdit(users[i], { content: `edited-${i}` });
      manager.appendContextEdit(answers[i], null);
      manager.appendContextEdit(answers[i], { content: [{ type: 'text', text: `restored-${i}` }] });
      manager.appendContextEdit(answers[i], null);
    }
    const source = manager.getSessionFile()!;
    const before = manager.buildSessionContext().messages;
    let path = source;
    let retained = [0, 1, 2];
    if (operation === 'prefix' || operation === 'single') {
      const result = await run(forkPiSession(source, users[1], operation));
      const { findPiSession } = await import('./piSessionLive');
      path = (await run(findPiSession(home, result!.newSessionId)))!.path;
      retained = operation === 'prefix' ? [0, 1] : [1];
    } else {
      const index = { 'delete-first': 0, 'delete-middle': 1, 'delete-last': 2 }[operation];
      await run(deletePiTurn(source, users[index]));
      retained = retained.filter((i) => i !== index);
    }
    const reopened = SessionManager.open(path);
    expect(reopened.buildSessionContext().messages).toEqual(retained.map((i) => before[i]));
    const branch = reopened.getBranch();
    const contextEdits = branch.filter((e) => e.type === 'context_edit');
    expect(new Set(contextEdits.map((e) => e.id)).size).toBe(contextEdits.length);
    expect(contextEdits.every((e) => branch.some((target) => target.type === 'message' && target.id === e.targetId))).toBe(true);
    if (path !== source) expect(SessionManager.open(source).buildSessionContext().messages).toEqual(before);
  },
);

it('freezes an active child snapshot at complete JSONL records and marks it interrupted', async () => {
  const f = await fixture('active-snapshot');
  const { findPiSession } = await import('./piSessionLive');
  const original = (await run(listPiChildren(f.path, 'active-snapshot'))).find((c) => c.id === 'child-b')!;
  const source = resolve(projectDir, 'active-snapshot', original.sessionPath);
  // Simulate a reader observing a write between records.
  await writeFile(source, (await readFile(source, 'utf8')) + '{"incomplete":');
  const fork = await run(forkPiSession(f.path, f.second, 'single'));
  const copy = (await run(findPiSession(home, fork!.newSessionId)))!;
  const copied = (await run(listPiChildren(copy.path, copy.id)))[0];
  expect(copied.status).toBe('interrupted');
  const snapshotPath = resolve(dirname(copy.path), copy.id, copied.sessionPath);
  const snapshot = await readFile(snapshotPath, 'utf8');
  expect(snapshot).not.toContain('incomplete');
  expect(snapshot).toContain('Frozen child history');
  expect(() => SessionManager.open(snapshotPath)).not.toThrow();
  await run(finishPiChildSession(f.path, 'active-snapshot', original, 'cancelled'));
  expect((await run(listPiChildren(copy.path, copy.id)))[0].status).toBe('interrupted');
  expect(await readFile(snapshotPath, 'utf8')).toBe(snapshot);
});

it('persists host fallback as inspectable metadata and avoids duplicating native output', async () => {
  const f = await fixture('partial-fallback');
  const path = resolve(projectDir, 'partial-fallback', f.a.sessionPath);
  await run(retainPiChildPartial(path, 'Child answer'));
  expect(SessionManager.open(path).getBranch().filter((e) => e.type === 'custom' && e.customType === 'cockpit.subagent-interrupted-output')).toHaveLength(0);
  await run(retainPiChildPartial(path, 'Unique interrupted partial'));
  const { piBranchMessages } = await import('../server/engines/piEvents');
  const rows = piBranchMessages(SessionManager.open(path).getBranch());
  expect(JSON.stringify(rows)).toContain('Unique interrupted partial');
  expect(JSON.stringify(rows)).toContain('incomplete');
});
