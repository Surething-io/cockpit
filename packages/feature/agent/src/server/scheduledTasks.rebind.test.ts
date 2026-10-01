/**
 * A scheduled task that had to start a FRESH session must adopt that session's id the
 * moment the engine reveals it — while the run is still going — and persist it there and
 * then.
 *
 * The rebind used to happen after the run finished AND only on the success path, so a
 * task spent the whole turn (up to the run deadline) pointing at the session that was
 * already gone: the panel opened an empty transcript while the real one streamed under
 * another id, and any failed round threw before the rebind, leaving the dead id on disk.
 * That is self-reinforcing — the next round starts yet another from-scratch session, and
 * a from-scratch run carries no context, so it is the one most likely to fail again.
 */
import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';

const RUN_KEY = 'run-provisional';
const FRESH_SESSION = '01a0c395-4b84-7192-88ba-3d4f50f2d257';
const DEAD_SESSION = 'dead-session-id'; // no rollout on disk → the startFresh branch

// Mutable stand-in for the run registry: tests drive `active` / `sessionId` to reproduce
// "the engine announces its id a few seconds in, then keeps running".
const hub = vi.hoisted(() => ({
  active: true,
  sessionId: null as string | null,
  status: 'idle' as 'idle' | 'error',
  stopped: false,
}));

vi.mock('./sessionRunHub', () => ({
  isRunActive: () => hub.active,
  getRunSessionId: () => hub.sessionId,
  getRunSnapshot: () => ({ status: hub.status, seq: 1, events: [], startedAt: Date.now() }),
  requestStop: () => { hub.stopped = true; },
}));

vi.mock('./engines/orchestrator', () => ({
  dispatchChat: vi.fn(async () => ({ ok: true as const, runKey: RUN_KEY })),
}));

vi.mock('./state/globalState', () => ({ updateGlobalState: vi.fn(async () => {}) }));

let home: string;
let taskFile: string;
let mod: typeof import('./scheduledTasks');
let Effect: typeof import('effect').Effect;

const TASK_ID = 'task-managed';
// Distinct ids matter: persistSessionRebind resolves the managed entry BY id, so a
// standalone fixture reusing TASK_ID would write through to the file the last test reads.
const task = (id = TASK_ID): import('./scheduledTasks').ScheduledTask => ({
  id,
  cwd: '/Users/x/proj',
  tabId: 'tab-1',
  sessionId: DEAD_SESSION,
  engine: 'codex',
  message: 'do the thing',
  type: 'cron',
  cron: '0 9 * * *',
  nextFireTime: Date.now() + 3600_000,
  paused: false,
  createdAt: Date.now(),
});

const onDisk = () =>
  (JSON.parse(readFileSync(taskFile, 'utf-8')) as import('./scheduledTasks').ScheduledTask[])
    .find(t => t.id === TASK_ID)!;

beforeAll(async () => {
  // COCKPIT_HOME is read at paths.ts module load, so it must be set before the import.
  home = mkdtempSync(join(tmpdir(), 'cockpit-home-'));
  process.env.COCKPIT_HOME = home;
  taskFile = join(home, 'scheduled-tasks.json');
  writeFileSync(taskFile, JSON.stringify([task()]), 'utf-8');

  mod = await import('./scheduledTasks');
  ({ Effect } = await import('effect'));
  await mod.scheduledTaskManager.init();
});

afterAll(() => {
  rmSync(home, { recursive: true, force: true });
});

beforeEach(() => {
  hub.active = false;
  hub.sessionId = FRESH_SESSION;
  hub.status = 'idle';
  hub.stopped = false;
});

describe('scheduled task session rebind', () => {
  it('rebinds the fresh session id when the run FAILS', async () => {
    hub.status = 'error';
    const t = task('task-standalone-error');
    const ok = await Effect.runPromise(mod.sendChatMessageEff(t));
    expect(ok).toBe(false); // still reported as a failed round
    expect(t.sessionId).toBe(FRESH_SESSION); // ...but the next round resumes, not restarts
  });

  it('rebinds the fresh session id when the run succeeds', async () => {
    const t = task('task-standalone-ok');
    const ok = await Effect.runPromise(mod.sendChatMessageEff(t));
    expect(ok).toBe(true);
    expect(t.sessionId).toBe(FRESH_SESSION);
  });

  it('binds and persists MID-RUN, as soon as the engine announces the id', async () => {
    hub.active = true;
    hub.sessionId = null; // not announced yet
    expect(onDisk().sessionId).toBe(DEAD_SESSION);

    // The board only refetches when told to, so the rebind has to announce itself too.
    const fired: string[] = [];
    mod.scheduledTaskManager.setOnTaskFired(t => fired.push(t.sessionId));

    // Managed path: the manager owns the task object, so the rebind must reach the file.
    const queued = await mod.scheduledTaskManager.triggerTask(TASK_ID);
    expect(queued).toBe(true);

    hub.sessionId = FRESH_SESSION; // engine announced (ctx.rekey), run still going
    // One wait for both: persistSessionRebind announces only after its write resolves, so
    // the file can already show the new id while the announcement is a tick away.
    await vi.waitFor(() => {
      expect(onDisk().sessionId).toBe(FRESH_SESSION);
      expect(fired).toEqual([FRESH_SESSION]); // ...and announced, so the board repoints now
    }, { timeout: 3000 });
    expect(hub.active).toBe(true); // ...persisted while the turn is still in flight
    expect(hub.stopped).toBe(false); // nowhere near the deadline

    hub.active = false; // let the run finish so the manager unwinds
    await vi.waitFor(() => expect(onDisk().lastResult).toBe('success'), { timeout: 3000 });
  });
});
