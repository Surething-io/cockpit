import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect, Fiber } from 'effect';
import type { AssistantMessage } from '@earendil-works/pi-ai';

const hooks = vi.hoisted(() => ({
  afterStat: undefined as ((path: string) => void) | undefined,
  beforeRm: undefined as ((path: string) => void | Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, stat: async (...args: unknown[]) => {
    const snapshot = await Reflect.apply(actual.stat, actual, args);
    hooks.afterStat?.(String(args[0]));
    return snapshot;
  }, rm: async (...args: unknown[]) => {
    await hooks.beforeRm?.(String(args[0]));
    return Reflect.apply(actual.rm, actual, args);
  } };
});
const root = mkdtempSync(join(tmpdir(), 'cockpit-retention-lease-'));
process.env.HOME = join(root, 'home'); process.env.USERPROFILE = process.env.HOME;
process.env.COCKPIT_HOME = join(root, 'cockpit');
let sdk: typeof import('@earendil-works/pi-coding-agent');
let cleanup: typeof import('./sessionCleanupLive');
let hub: typeof import('../server/sessionRunHub');
beforeAll(async () => {
  sdk = await import('@earendil-works/pi-coding-agent'); cleanup = await import('./sessionCleanupLive');
  hub = await import('../server/sessionRunHub');
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const answer: AssistantMessage = { role: 'assistant', content: [{ type: 'text', text: 'answer' }], api: 'openai-completions', provider: 'ollama', model: 'test', timestamp: 1, stopReason: 'stop',
  usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } };
const fixture = (id: string) => {
  const store = join(root, id), dir = join(store, 'project'), pins = join(root, `${id}-pins.json`);
  const manager = sdk.SessionManager.create(root, dir, { id });
  manager.appendMessage({ role: 'user', content: 'old history', timestamp: 1 }); manager.appendMessage(answer);
  const file = manager.getSessionFile()!, attachments = join(dir, id);
  mkdirSync(attachments); writeFileSync(join(attachments, 'child.jsonl'), 'retained child data');
  utimesSync(file, new Date('2000-01-01'), new Date('2000-01-01'));
  return { id, store, dir, pins, file, attachments, manager };
};
const reset = (id: string) => {
  hooks.afterStat = undefined; hooks.beforeRm = undefined;
  hub.markRunIdle(id); hub.releaseRun(id);
};
const runCleanup = (f: ReturnType<typeof fixture>) => Effect.runPromise(cleanup.cleanupSessions(f.store, 30, f.pins));

describe('retention participates in the session writer lease', () => {
  it.each(['running', 'finished'] as const)('keeps appended history after the age probe when the run is %s', async (state) => {
    const f = fixture(`age-${state}`); let interleaved = false;
    hooks.afterStat = (path) => {
      if (path !== f.file || interleaved) return;
      interleaved = true; expect(hub.startRun(f.id, root, 'new input', f.id, 'ollama')).toBe(true);
      const writer = sdk.SessionManager.open(f.file);
      writer.appendMessage({ role: 'user', content: 'new accepted input', timestamp: Date.now() }); writer.appendMessage(answer);
      if (state === 'finished') { hub.markRunIdle(f.id); hub.releaseRun(f.id); }
    };
    try {
      await runCleanup(f); expect(interleaved).toBe(true);
      expect(existsSync(f.file)).toBe(true); expect(existsSync(f.attachments)).toBe(true);
      expect(JSON.stringify(sdk.SessionManager.open(f.file).getEntries())).toContain('new accepted input');
    } finally { reset(f.id); }
  });

  it.each(['pinned', 'unreadable'] as const)('rechecks %s protection after acquiring the lease', async (protection) => {
    const f = fixture(`protection-${protection}`); let changed = false;
    hooks.afterStat = (path) => {
      if (path === f.file && !changed) { changed = true; writeFileSync(f.pins, protection === 'pinned' ? JSON.stringify([{ sessionId: f.id }]) : '{'); }
    };
    try { await runCleanup(f); expect(changed).toBe(true); expect(existsSync(f.file)).toBe(true); expect(existsSync(f.attachments)).toBe(true); expect(hub.isSessionBusy(f.id)).toBe(false); }
    finally { reset(f.id); }
  });

  it('blocks resume while deleting a truly expired session and releases afterward', async () => {
    const f = fixture('expired'); let checked = false;
    hooks.beforeRm = (path) => {
      if (path === f.file) { checked = true; expect(hub.isSessionBusy(f.id)).toBe(true); expect(hub.startRun(f.id, root, 'too early', f.id, 'ollama')).toBe(false); }
    };
    try { await runCleanup(f); expect(checked).toBe(true); expect(existsSync(f.file)).toBe(false); expect(existsSync(f.attachments)).toBe(false); expect(hub.isSessionBusy(f.id)).toBe(false); }
    finally { reset(f.id); }
  });

  it('keeps its lease until pending deletion finishes after interruption', async () => {
    const f = fixture('interrupted-cleanup');
    let entered!: () => void, release!: () => void;
    const deleting = new Promise<void>((resolve) => { entered = resolve; });
    const allowed = new Promise<void>((resolve) => { release = resolve; });
    hooks.beforeRm = async (path) => { if (path === f.file) { entered(); await allowed; } };
    const fiber = Effect.runFork(cleanup.cleanupSessions(f.store, 30, f.pins));
    try {
      await deleting;
      const interrupted = Effect.runPromise(Fiber.interrupt(fiber));
      await Promise.resolve();
      expect(hub.isSessionBusy(f.id)).toBe(true);
      expect(hub.startRun(f.id, root, 'too early', f.id, 'ollama')).toBe(false);
      release(); await interrupted;
      expect(hub.isSessionBusy(f.id)).toBe(false);
      expect(existsSync(f.file)).toBe(false); expect(existsSync(f.attachments)).toBe(false);
    } finally { release(); await Effect.runPromise(Fiber.interrupt(fiber)); reset(f.id); }
  });

  it('releases on deletion failure and retains attachments when the transcript remains', async () => {
    const f = fixture('delete-failure');
    hooks.beforeRm = (path) => { if (path === f.file) throw Object.assign(new Error('Injected EIO'), { code: 'EIO' }); };
    try {
      await runCleanup(f); expect(existsSync(f.file)).toBe(true); expect(existsSync(f.attachments)).toBe(true);
      expect(hub.startRun(f.id, root, 'after failure', f.id, 'ollama')).toBe(true);
    } finally { reset(f.id); }
  });

  it('does not remove a shared project directory while a new writer initializes', async () => {
    const f = fixture('initializing');
    let writer: import('@earendil-works/pi-coding-agent').SessionManager | undefined;
    hooks.beforeRm = (path) => {
      if (path === f.attachments) {
        expect(hub.startRun('new-session', root, 'initializing', 'new-session', 'ollama')).toBe(true);
        writer = sdk.SessionManager.create(root, f.dir, { id: 'new-session' });
      }
    };
    try {
      await runCleanup(f); expect(writer).toBeDefined();
      writer!.appendMessage({ role: 'user', content: 'first new message', timestamp: Date.now() }); writer!.appendMessage(answer);
      expect(readFileSync(writer!.getSessionFile()!, 'utf8')).toContain('first new message');
    } finally { reset(f.id); reset('new-session'); }
  });
});
