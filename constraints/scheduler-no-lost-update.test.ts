/**
 * Constraint: SchedulerNoLostUpdate (invariant, L2).
 *
 * Changes made while a scheduled run is in flight — marking tasks read,
 * reordering, editing the running task — all survive the run's completion, and
 * the run's own result is recorded too. scheduled-tasks.json is the only
 * truth; every change is a patch applied by task id to the current record.
 *
 * Why: the manager kept an in-memory list and wrote it over the whole file
 * when a run ended. Edits made on disk meanwhile (read marks, order) were
 * reverted, and an edit that replaced the in-memory object made the run's
 * result land on an orphaned copy that never reached disk.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, describe, expect, it, vi } from 'vitest';

type Task = import('../packages/feature/agent/src/server/scheduledTasks').ScheduledTask;

const hub = vi.hoisted(() => ({ active: true, dispatched: 0 }));

vi.mock('../packages/feature/agent/src/server/sessionRunHub', () => ({
  isRunActive: () => hub.active,
  getRunSessionId: () => 'session-a',
  getRunSnapshot: () => ({ status: 'idle', seq: 1, events: [], startedAt: Date.now() }),
  requestStop: () => {},
}));
vi.mock('../packages/feature/agent/src/server/state/globalState', () => ({
  updateGlobalState: vi.fn(async () => {}),
}));
vi.mock('../packages/feature/agent/src/server/engines/orchestrator', () => ({
  dispatchChat: vi.fn(async () => {
    hub.dispatched += 1;
    return { ok: true as const, runKey: 'run-a' };
  }),
}));

const home = mkdtempSync(join(tmpdir(), 'cockpit-no-lost-update-'));
process.env.COCKPIT_HOME = home;
const file = join(home, 'scheduled-tasks.json');

const cronTask = (id: string, over: Partial<Task> = {}): Task => ({
  id,
  cwd: home,
  tabId: 'tab-1',
  sessionId: `session-${id}`,
  engine: 'ollama',
  message: `message ${id}`,
  type: 'cron',
  cron: '0 9 * * *',
  nextFireTime: Date.now() + 3600_000,
  paused: false,
  createdAt: Date.now(),
  ...over,
});

async function until(cond: () => boolean, ms = 8000) {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

async function untilAsync(cond: () => Promise<boolean>, ms = 8000) {
  const end = Date.now() + ms;
  while (!(await cond())) {
    if (Date.now() > end) throw new Error('timed out waiting');
    await new Promise((r) => setTimeout(r, 20));
  }
}

afterAll(() => rmSync(home, { recursive: true, force: true }));

describe('SchedulerNoLostUpdate', () => {
  it('read marks, order and edits made during a run survive it, and so does the result', async () => {
    writeFileSync(file, JSON.stringify([cronTask('a'), cronTask('b', { unread: true, sortIndex: 0 })]));
    const { scheduledTaskManager: m } = await import('../packages/feature/agent/src/server/scheduledTasks');
    await m.init();
    // Read through the manager (under the file lock), not readFileSync: writes are not
    // atomic, so an unlocked read can catch a half-written file.
    let snapshot: Task[] = [];
    const refresh = async () => { snapshot = await m.getTasks(); };
    const disk = (id: string): Task => snapshot.find((t) => t.id === id)!;

    // Start a run of task a and hold it in flight.
    hub.active = true;
    await m.triggerTask('a');
    await until(() => hub.dispatched === 1);

    // Changes while a is running.
    await m.markAllRead();
    await m.reorderTasks(['b', 'a']);
    await m.updateTask('a', { message: 'edited during run' });

    // Let the run finish and settle.
    hub.active = false;
    await untilAsync(async () => { await refresh(); return disk('a').lastResult !== undefined; });

    expect(disk('b').unread).toBe(false); // read mark kept
    expect(disk('b').sortIndex).toBe(0); // order kept
    expect(disk('a').sortIndex).toBe(1);
    expect(disk('a').message).toBe('edited during run'); // edit kept
    expect(disk('a').lastResult).toBe('success'); // and the run's result recorded
  }, 15_000);
});
