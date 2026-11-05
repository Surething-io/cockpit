import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect, Fiber } from 'effect';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const hooks = vi.hoisted(() => ({ beforeRename: undefined as ((destination: string) => Promise<void>) | undefined }));
vi.mock('fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, rename: async (...args: Parameters<typeof actual.rename>) => {
    await hooks.beforeRename?.(String(args[1]));
    return actual.rename(...args);
  } };
});
const root = mkdtempSync(join(tmpdir(), 'cockpit-pi-compatibility-'));
process.env.HOME = join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.COCKPIT_HOME = join(root, 'cockpit');
const cwd = join(root, 'project');
const timestamp = '2026-01-01T00:00:00.000Z';
let sdk: typeof import('@earendil-works/pi-coding-agent');
let pi: typeof import('./piSessionLive');
let edit: typeof import('./piSessionEditLive');
let paths: typeof import('@cockpit/shared-utils');
let hub: typeof import('../server/sessionRunHub');
let fork: typeof import('../server/api/session/fork');
let identity: typeof import('./piSessionIdentity');
let children: typeof import('./piSubagentSessionLive');
beforeAll(async () => {
  sdk = await import('@earendil-works/pi-coding-agent'); pi = await import('./piSessionLive');
  edit = await import('./piSessionEditLive'); paths = await import('@cockpit/shared-utils');
  hub = await import('../server/sessionRunHub'); fork = await import('../server/api/session/fork');
  identity = await import('./piSessionIdentity'); children = await import('./piSubagentSessionLive');
  mkdirSync(cwd, { recursive: true });
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const run = Effect.runPromise;
const assistant = (text: string, tool?: string): AssistantMessage => ({ role: 'assistant', api: 'openai-completions', provider: 'ollama', model: 'test', stopReason: 'stop', timestamp: 2,
  content: tool ? [{ type: 'toolCall', id: tool, name: 'subagent', arguments: { task: tool } }] : [{ type: 'text', text }],
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } });
const user = (text: string) => ({ role: 'user' as const, content: text, timestamp: 1 });
const write = (file: string, entries: unknown[]) => writeFileSync(file, entries.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
const legacy = (id: string) => {
  const dir = paths.getPiSessionsDir(cwd); mkdirSync(dir, { recursive: true });
  const file = join(dir, `${id}.jsonl`);
  write(file, [{ type: 'session', version: 1, id, cwd, timestamp },
    { type: 'model_change', provider: 'ollama', modelId: 'test', timestamp },
    ...['duplicate', 'duplicate', 'last'].flatMap((text) => [
      { type: 'message', message: user(text), timestamp }, { type: 'message', message: assistant(text), timestamp },
    ])]);
  return file;
};
const postFork = (id: string, fromMessageUuid?: string) => fork.POST(new Request('http://localhost/fork', {
  method: 'POST', body: JSON.stringify({ cwd, fromMessageUuid }),
}), { params: Promise.resolve({ sessionId: id }) });
const deferred = () => { let resolve!: () => void; const promise = new Promise<void>((done) => { resolve = done; }); return { promise, resolve }; };

describe('Pi legacy identity across native migration', () => {
  it.each(['prefix', 'single', 'delete'] as const)('resolves a displayed duplicate after native open and append for %s', async (action) => {
    const file = legacy(`external-${action}`);
    const displayed = await run(pi.readPiSession(file));
    const users = displayed.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user');
    const native = sdk.SessionManager.open(file);
    const nativeUsers = native.getEntries().filter((entry) => entry.type === 'message' && entry.message.role === 'user');
    native.appendMessage(user('concurrent later input')); native.appendMessage(assistant('later reply'));
    expect(identity.resolvePiEntryId(native.getSessionId(), native.getEntries(), users[1].id)).toBe(nativeUsers[1].id);
    if (action === 'delete') {
      expect(await run(edit.deletePiTurn(file, users[1].id))).toMatchObject({ targetMissed: false });
      const remaining = sdk.SessionManager.open(file).getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'user');
      expect(remaining.map((entry) => entry.id)).toEqual([nativeUsers[0].id, nativeUsers[2].id, native.getBranch().findLast((entry) => entry.type === 'message' && entry.message.role === 'user')!.id]);
    } else {
      const result = await run(edit.forkPiSession(file, users[1].id, action));
      expect(result).toBeDefined();
      const child = await run(pi.findPiSession(cwd, result!.newSessionId));
      const copied = sdk.SessionManager.open(child!.path).getBranch().filter((entry) => entry.type === 'message' && entry.message.role === 'user');
      expect(copied).toHaveLength(action === 'prefix' ? 2 : 1);
    }
  });

  it.each(['reorder', 'change', 'other-session'] as const)('rejects a stale locator after %s without changing bytes', async (mutation) => {
    const file = legacy(`stale-${mutation}`);
    const displayed = await run(pi.readPiSession(file));
    const target = displayed.entries.find((entry) => entry.type === 'message' && entry.message.role === 'user')!.id;
    const native = sdk.SessionManager.open(file);
    const entries = native.getEntries();
    if (mutation === 'reorder') entries.splice(0, 0, { type: 'custom', id: 'extra', parentId: null, timestamp, customType: 'external-insert' });
    if (mutation === 'change') {
      const message = entries.find((entry) => entry.type === 'message' && entry.message.role === 'user')!;
      if (message.type === 'message') message.message = user('changed input');
    }
    write(file, [{ ...native.getHeader(), id: mutation === 'other-session' ? 'different-session' : native.getSessionId() }, ...entries]);
    const before = readFileSync(file);
    const result = await run(Effect.either(edit.deletePiTurn(file, target)));
    expect(result._tag).toBe('Left');
    if (result._tag === 'Left') expect(result.left._tag).toBe('ValidationError');
    expect(readFileSync(file)).toEqual(before);
  });
});

describe('Pi fork owns its source writer lease', () => {
  it('blocks a run and another fork while migration is paused, then releases the lease', async () => {
    const id = 'lease-interleave'; const file = legacy(id);
    const entered = deferred(), release = deferred();
    hooks.beforeRename = async (destination) => { if (destination === file) { entered.resolve(); await release.promise; } };
    const pending = postFork(id);
    try {
      await entered.promise;
      expect(hub.isSessionBusy(id)).toBe(true);
      expect(hub.startRun(id, cwd, 'new input', id, 'ollama')).toBe(false);
      expect((await postFork(id)).status).toBe(400);
      release.resolve();
      expect((await pending).status).toBe(200);
      expect(hub.isSessionBusy(id)).toBe(false);
      expect(hub.startRun(id, cwd, 'later input', id, 'ollama')).toBe(true);
      const writer = sdk.SessionManager.open(file); writer.appendMessage(user('later input')); writer.appendMessage(assistant('later answer'));
      expect(JSON.stringify(sdk.SessionManager.open(file).getEntries())).toContain('later input');
    } finally { hooks.beforeRename = undefined; release.resolve(); await pending; hub.markRunIdle(id); hub.releaseRun(id); }
  });

  it('holds the lease until an in-flight write finishes after interruption', async () => {
    const id = 'lease-interrupted'; const file = legacy(id);
    const entered = deferred(), release = deferred();
    hooks.beforeRename = async (destination) => { if (destination === file) { entered.resolve(); await release.promise; } };
    const endEdit = hub.beginTranscriptEdit(id)!;
    const fiber = Effect.runFork(edit.forkPiSession(file).pipe(Effect.ensuring(Effect.sync(endEdit))));
    try {
      await entered.promise;
      const interrupted = run(Fiber.interrupt(fiber));
      await Promise.resolve();
      expect(hub.isSessionBusy(id)).toBe(true);
      expect(hub.startRun(id, cwd, 'too early', id, 'ollama')).toBe(false);
      release.resolve(); await interrupted;
      expect(hub.isSessionBusy(id)).toBe(false);
      expect(() => sdk.SessionManager.open(file)).not.toThrow();
    } finally { hooks.beforeRename = undefined; release.resolve(); await run(Fiber.interrupt(fiber)); }
  });

  it('refuses a busy source before migration and releases its lease on write failure', async () => {
    const id = 'lease-failure'; const file = legacy(id); const before = readFileSync(file);
    hub.startRun(id, cwd, 'running', id, 'ollama');
    try { expect((await postFork(id)).status).toBe(400); expect(readFileSync(file)).toEqual(before); }
    finally { hub.markRunIdle(id); hub.releaseRun(id); }
    hooks.beforeRename = async (destination) => { if (destination === file) throw Object.assign(new Error('Injected write failure'), { code: 'EIO' }); };
    try { expect((await postFork(id)).status).toBeGreaterThanOrEqual(400); expect(hub.isSessionBusy(id)).toBe(false); expect(readFileSync(file)).toEqual(before); }
    finally { hooks.beforeRename = undefined; }
    expect((await postFork(id)).status).toBe(200);
  });
});

describe('Pi current-branch deletion preserves the complete tree', () => {
  it.each([2, 3])('preserves v%s branches and child history when deleting shared or exclusive nodes', async (version) => {
    for (const selection of ['shared', 'active-only', 'shared-root'] as const) {
    const manager = sdk.SessionManager.create(cwd, paths.getPiSessionsDir(cwd));
    const first = manager.appendMessage(user('shared first'));
    manager.appendMessage(assistant('shared answer', 'shared-call'));
    const shared = manager.appendMessage(user('shared second'));
    const forkPoint = manager.appendMessage(assistant('second answer'));
    manager.appendMessage(user('side task'));
    manager.appendMessage(assistant('side answer', 'side-call'));
    const sideSummary = manager.appendCompaction('side summary', shared, 20);
    manager.appendContextEdit(shared, { content: 'edited second' });
    const sideLeaf = manager.appendLabelChange(shared, 'side label');
    const sideEntries = manager.getBranch(sideLeaf);
    manager.branchWithSummary(forkPoint, 'active branch summary');
    const active = manager.appendMessage(user('active task'));
    manager.appendMessage(assistant('active answer', 'active-call'));
    manager.appendContextEdit(shared, { content: 'edited second' });
    manager.appendCompaction('active summary contains shared second', active, 20);
    manager.appendLabelChange(active, 'active label');
    const parentPath = manager.getSessionFile()!, id = manager.getSessionId();
    for (const call of ['shared-call', 'side-call', 'active-call']) await run(children.createPiChildSession(parentPath, id, cwd, {
      id: call, toolUseId: call, name: call, task: call, model: 'test', index: 0,
    }, 'child instructions'));
    const target = selection === 'shared' ? shared : selection === 'shared-root' ? first : active;
    const original = manager.getEntries();
    if (version === 2) write(parentPath, [{ ...manager.getHeader(), version }, ...original]);
    expect(await run(edit.deletePiTurn(parentPath, target))).toMatchObject({ targetMissed: false });
    const reopened = sdk.SessionManager.open(parentPath);
    expect(reopened.getBranch(sideLeaf)).toEqual(sideEntries);
    const current = reopened.getBranch();
    expect(current.some((entry) => entry.id === target)).toBe(false);
    expect(current.some((entry) => entry.type === 'compaction' || entry.type === 'branch_summary')).toBe(false);
    expect(reopened.getEntries().find((entry) => entry.id === sideSummary)).toEqual(original.find((entry) => entry.id === sideSummary));
    if (selection !== 'active-only') {
      expect(current.some((entry) => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'active task')).toBe(true);
      expect(current.find((entry) => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'shared second')?.id === shared).toBe(false);
    }
    const calls = await run(children.listPiChildren(parentPath, id));
    expect(calls.some((child) => child.toolUseId === 'shared-call')).toBe(true);
    expect(calls.some((child) => child.toolUseId === 'side-call')).toBe(true);
    expect(calls.some((child) => child.toolUseId === 'active-call')).toBe(selection !== 'active-only');
    const entries = reopened.getEntries(); const ids = new Set(entries.map((entry) => entry.id));
    for (const entry of entries) {
      expect(entry.parentId === null || ids.has(entry.parentId)).toBe(true);
      if (entry.type === 'context_edit' || entry.type === 'label') expect(ids.has(entry.targetId)).toBe(true);
    }
    reopened.appendMessage(user('resumed after delete')); reopened.appendMessage(assistant('resumed answer'));
    expect(sdk.SessionManager.open(parentPath).getBranch(sideLeaf)).toEqual(sideEntries);
    expect(JSON.stringify(sdk.SessionManager.open(parentPath).buildSessionContext().messages)).toContain('resumed after delete');
    }
  });
  it.each(['compaction', 'branch_summary', 'label-chain'] as const)('drops labels whose %s target is invalidated outside the deleted turn', async (kind) => {
    const manager = sdk.SessionManager.create(cwd, paths.getPiSessionsDir(cwd));
    const first = manager.appendMessage(user('first kept turn'));
    const common = manager.appendMessage(assistant('first answer'));
    manager.appendMessage(user('second kept turn')); manager.appendMessage(assistant('second answer'));
    const summary = kind === 'branch_summary'
      ? manager.branchWithSummary(common, 'old branch summary')
      : manager.appendCompaction('old summary', first, 20);
    const oldLabel = kind === 'label-chain' ? manager.appendLabelChange(summary, 'summary label') : summary;
    const target = manager.appendMessage(user('third removed turn')); manager.appendMessage(assistant('third answer'));
    manager.appendLabelChange(oldLabel, 'later label');
    const file = manager.getSessionFile()!;
    expect(await run(edit.deletePiTurn(file, target))).toMatchObject({ targetMissed: false });
    const reopened = sdk.SessionManager.open(file);
    expect(reopened.getEntry(summary)).toBeUndefined();
    expect(reopened.getBranch().some((entry) => entry.id === target)).toBe(false);
    const ids = new Set(reopened.getEntries().map((entry) => entry.id));
    expect(reopened.getEntries().filter((entry) => entry.type === 'label').every((entry) => ids.has(entry.targetId))).toBe(true);
    expect(JSON.stringify(reopened.buildSessionContext().messages)).toContain('first kept turn');
  });

  it('retains the original summary and labels still referenced by an untouched branch', async () => {
    const manager = sdk.SessionManager.create(cwd, paths.getPiSessionsDir(cwd));
    const first = manager.appendMessage(user('common input')); manager.appendMessage(assistant('common answer'));
    const summary = manager.appendCompaction('shared summary', first, 20);
    manager.appendMessage(user('side task')); manager.appendMessage(assistant('side answer'));
    const sideLeaf = manager.appendLabelChange(summary, 'side bookmark');
    const side = manager.getBranch(sideLeaf);
    manager.branch(summary);
    const target = manager.appendMessage(user('active removed task')); manager.appendMessage(assistant('active answer'));
    manager.appendLabelChange(summary, 'latest bookmark');
    const file = manager.getSessionFile()!;
    await run(edit.deletePiTurn(file, target));
    const reopened = sdk.SessionManager.open(file);
    expect(reopened.getBranch(sideLeaf)).toEqual(side);
    expect(reopened.getEntry(summary)).toBeDefined();
    expect(reopened.getLabel(summary)).toBe('latest bookmark');
    expect(reopened.getBranch().some((entry) => entry.id === summary || entry.id === target)).toBe(false);
  });

  it.each(['new', '', undefined, 'old'])('retains the final global label %s on original and copied targets', async (latestLabel) => {
    for (const cloneTarget of [false, true]) {
      const manager = sdk.SessionManager.create(cwd, paths.getPiSessionsDir(cwd));
      const rootMessage = manager.appendMessage(user('shared root')); manager.appendMessage(assistant('root answer'));
      const labeled = manager.appendMessage(user('labeled shared input'));
      const common = manager.appendMessage(assistant('shared answer'));
      manager.appendLabelChange(labeled, 'old'); const oldLabelLeaf = manager.getLeafId()!;
      manager.branch(common);
      manager.appendMessage(user('side task')); manager.appendMessage(assistant('side answer'));
      const sideLeaf = manager.appendLabelChange(labeled, latestLabel);
      const latest = manager.getEntries().find((entry) => entry.id === sideLeaf)!;
      latest.timestamp = '2026-11-04T12:34:56.000Z';
      const side = manager.getBranch(sideLeaf);
      manager.branch(oldLabelLeaf);
      const active = manager.appendMessage(user('active task')); manager.appendMessage(assistant('active answer'));
      const file = manager.getSessionFile()!;
      write(file, [manager.getHeader(), ...manager.getEntries()]);
      await run(edit.deletePiTurn(file, cloneTarget ? rootMessage : active));
      const reopened = sdk.SessionManager.open(file);
      expect(reopened.getBranch(sideLeaf)).toEqual(side);
      expect(reopened.getLabel(labeled)).toBe(latestLabel || undefined);
      const currentTarget = reopened.getBranch().find((entry) => entry.type === 'message' && entry.message.role === 'user' && entry.message.content === 'labeled shared input')!;
      expect(currentTarget.id === labeled).toBe(!cloneTarget);
      expect(reopened.getLabel(currentTarget.id)).toBe(latestLabel || undefined);
      const flatten = (nodes: ReturnType<typeof reopened.getTree>): typeof nodes => nodes.flatMap((node) => [node, ...flatten(node.children)]);
      const targetNode = flatten(reopened.getTree()).find((node) => node.entry.id === currentTarget.id)!;
      expect(targetNode.labelTimestamp).toBe(latestLabel ? latest.timestamp : undefined);
      expect(reopened.getBranch().at(-1)?.type).toBe('custom');
    }
  });

  it.each(['Current title', '', '   '])('retains the native global name %s after deleting an unrelated current turn', async (latestName) => {
    const manager = sdk.SessionManager.create(cwd, paths.getPiSessionsDir(cwd));
    const first = manager.appendMessage(user('common root'));
    const common = manager.appendMessage(assistant('common answer'));
    manager.appendSessionInfo('Old title');
    const oldNameLeaf = manager.getLeafId()!;
    manager.branch(common);
    manager.appendMessage(user('side path'));
    manager.appendSessionInfo(latestName);
    const sideLeaf = manager.getLeafId()!;
    const side = manager.getBranch(sideLeaf);
    manager.branch(oldNameLeaf);
    const active = manager.appendMessage(user('delete me'));
    manager.appendMessage(assistant('active answer'));
    const file = manager.getSessionFile()!;
    const before = manager.getSessionName();
    expect(before).toBe(latestName?.trim() || undefined);
    await run(edit.deletePiTurn(file, active));
    const reopened = sdk.SessionManager.open(file);
    expect(reopened.getSessionName()).toBe(before);
    expect(reopened.getBranch(sideLeaf)).toEqual(side);
    expect(reopened.getBranch().some((entry) => entry.id === first)).toBe(true);
    expect(reopened.getBranch().some((entry) => entry.id === active)).toBe(false);
    expect(reopened.getBranch().at(-1)?.type).toBe('custom');
  });

  it('persists an empty active path without switching to the remaining side branch', async () => {
    const manager = sdk.SessionManager.create(cwd, paths.getPiSessionsDir(cwd));
    const first = manager.appendMessage(user('only shared turn'));
    const common = manager.appendMessage(assistant('only answer'));
    manager.appendMessage(user('side remains')); const side = manager.appendMessage(assistant('side answer'));
    const before = manager.getBranch(side);
    manager.branch(common); manager.appendCustomEntry('active marker', {});
    const file = manager.getSessionFile()!;
    await run(edit.deletePiTurn(file, first));
    const reopened = sdk.SessionManager.open(file);
    expect(reopened.buildSessionContext().messages).toEqual([]);
    expect(reopened.getSessionName()).toBeUndefined();
    expect(reopened.getEntries().some((entry) => entry.type === 'session_info')).toBe(false);
    expect(reopened.getBranch(side)).toEqual(before);
    expect(reopened.getBranch()).toHaveLength(1);
    reopened.appendMessage(user('new root')); reopened.appendMessage(assistant('new answer'));
    expect(sdk.SessionManager.open(file).getBranch(side)).toEqual(before);
  });

  it('rejects shifted duplicate locators rather than editing the next identical message', async () => {
    const file = legacy('duplicate-shift');
    const displayed = await run(pi.readPiSession(file));
    const target = displayed.entries.filter((entry) => entry.type === 'message' && entry.message.role === 'user')[1].id;
    const manager = sdk.SessionManager.open(file);
    const entries = manager.getEntries();
    entries.splice(1, 2);
    write(file, [manager.getHeader(), ...entries]);
    const before = readFileSync(file);
    const result = await run(Effect.either(edit.deletePiTurn(file, target)));
    expect(result._tag).toBe('Left');
    expect(readFileSync(file)).toEqual(before);
  });

});
