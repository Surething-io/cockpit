/**
 * Constraint: OnceTaskAtMostOnce (state machine, L2).
 *
 * A scheduled run is claimed on disk BEFORE its prompt is sent, and a claim
 * found on startup is never re-sent: the previous process died mid-run, so the
 * run is recorded as interrupted instead. Together these make a `once` task
 * fire at most once across a crash or restart.
 *
 * Why: `completed` used to be written only after the run finished (up to an
 * hour later). A process killed mid-run (cockpit stop, updater SIGKILL) came
 * back with the task still pending and — within the missed-once grace window —
 * sent the same prompt again.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

type Task = import('../packages/feature/agent/src/server/scheduledTasks').ScheduledTask;

const seen = vi.hoisted(() => ({ dispatches: 0, diskAtDispatch: null as unknown }));
const hub = vi.hoisted(() => ({ active: false }));

vi.mock('../packages/feature/agent/src/server/sessionRunHub', () => ({
  isRunActive: () => hub.active,
  getRunSessionId: () => 'session-1',
  getRunSnapshot: () => ({ status: 'idle', seq: 1, events: [], startedAt: Date.now() }),
  requestStop: () => {},
}));
vi.mock('../packages/feature/agent/src/server/state/globalState', () => ({
  updateGlobalState: vi.fn(async () => {}),
}));

const home = mkdtempSync(join(tmpdir(), 'cockpit-at-most-once-'));
process.env.COCKPIT_HOME = home;
const file = join(home, 'scheduled-tasks.json');
const disk = (): Task[] => JSON.parse(readFileSync(file, 'utf8'));

vi.mock('../packages/feature/agent/src/server/engines/orchestrator', () => ({
  dispatchChat: vi.fn(async () => {
    seen.dispatches += 1;
    seen.diskAtDispatch = JSON.parse(readFileSync(file, 'utf8'));
    return { ok: true as const, runKey: 'run-1' };
  }),
}));

const onceTask = (over: Partial<Task> = {}): Task => ({
  id: 'once-1',
  cwd: home,
  tabId: 'tab-1',
  sessionId: 'session-1',
  engine: 'ollama',
  message: 'do it once',
  type: 'once',
  nextFireTime: Date.now() - 1000, // due now (inside the missed-once grace window)
  paused: false,
  createdAt: Date.now() - 60_000,
  ...over,
});

/** A fresh manager, as a restarted process would have. */
async function boot() {
  vi.resetModules();
  delete (globalThis as { __scheduledTaskManager?: unknown }).__scheduledTaskManager;
  const mod = await import('../packages/feature/agent/src/server/scheduledTasks');
  await mod.scheduledTaskManager.init();
  return mod.scheduledTaskManager;
}

async function until(cond: () => boolean, ms = 5000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

beforeEach(() => {
  seen.dispatches = 0;
  seen.diskAtDispatch = null;
  hub.active = false;
});

describe('OnceTaskAtMostOnce', () => {
  it('claims the run on disk before the prompt is sent', async () => {
    writeFileSync(file, JSON.stringify([onceTask()]));
    await boot();
    await until(() => seen.dispatches === 1);

    const claimed = (seen.diskAtDispatch as Task[]).find((t) => t.id === 'once-1')!;
    expect(claimed.firingSince).toEqual(expect.any(Number));
    expect(claimed.completed).toBe(true);
  });

  it('a claim found on startup is recorded as interrupted, not sent again', async () => {
    writeFileSync(file, JSON.stringify([onceTask({ firingSince: Date.now() - 5000, completed: true })]));
    await boot();
    await new Promise((r) => setTimeout(r, 300)); // give a wrongly armed timer time to fire

    expect(seen.dispatches).toBe(0);
    const task = disk().find((t) => t.id === 'once-1')!;
    expect(task.firingSince).toBeUndefined();
    expect(task.lastResult).toBe('interrupted');
    expect(task.completed).toBe(true);
  });
});
