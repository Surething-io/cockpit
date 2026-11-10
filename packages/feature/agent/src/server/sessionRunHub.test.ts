// Regression net for sessionRunHub (#10). Run with `npm test` (vitest) or
// `npx vitest run <this file>`.
//
// The registry is a globalThis-pinned singleton, so these cases are STATEFUL and build on
// each other — they must run in order. vitest runs it() blocks in definition order within a
// file, and runs files in isolated workers, so the shared state stays self-contained here.
import { describe, it, expect, vi } from 'vitest';
import {
  startRun,
  appendRun,
  rekeyRun,
  markRunIdle,
  isRunActive,
  getRunSnapshot,
  getRunRecoveries,
  getRecoveryDeletions,
  deleteRunRecoveryTurns,
  MAX_RECOVERY_DELETIONS,
  MAX_RECOVERY_IDS_PER_SESSION,
  MAX_RECOVERY_IDS_TOTAL,
  MAX_RECOVERY_JOURNALS,
  addRunListener,
  releaseRun,
  waitForWriter,
  isSessionBusy,
  requestStop,
} from './sessionRunHub';

describe('sessionRunHub (#10 run registry)', () => {
  it('retains the server task-start clock in live delivery and reconnect snapshots', () => {
    startRun('TASK-CLOCK', '/cwd');
    const received: unknown[] = [];
    const offClock = addRunListener('TASK-CLOCK', (event) => received.push(event.message));
    const frame = { type: 'system', subtype: 'init', session_id: 'TASK-CLOCK' };
    const before = Date.now();
    appendRun('TASK-CLOCK', frame);
    const stored = getRunSnapshot('TASK-CLOCK')!.events[0] as typeof frame & { _ts: number };
    expect(stored._ts).toBeGreaterThanOrEqual(before);
    expect(stored._ts).toBeLessThanOrEqual(Date.now());
    expect(received[0]).toEqual(stored);
    expect(frame).not.toHaveProperty('_ts');
    offClock();
    markRunIdle('TASK-CLOCK');
    releaseRun('TASK-CLOCK');
  });
  const got: Array<{ seq: number; message: unknown }> = [];
  let off: () => void;

  it('active after startRun', () => {
    startRun('S', '/cwd');
    expect(isRunActive('S')).toBe(true);
  });

  it('listener receives events with monotonic seq', () => {
    off = addRunListener('S', (ev) => got.push(ev));
    appendRun('S', { type: 'assistant', uuid: 'u1' });
    appendRun('S', { type: 'assistant', uuid: 'u2' });
    expect(got.length).toBe(2);
    expect(got[1].seq).toBe(2);
  });

  it('snapshot carries seq + events', () => {
    expect(getRunSnapshot('S')?.seq).toBe(2);
    expect(getRunSnapshot('S')?.events.length).toBe(2);
  });

  it('usage_update is fanned out but not stored in the snapshot', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    startRun('PROGRESS', '/cwd');
    const offProgress = addRunListener('PROGRESS', (ev) => evs.push(ev));
    appendRun('PROGRESS', { type: 'usage_update', output_tokens: 42 });
    expect(evs.length).toBe(1);
    expect((evs[0].message as { type?: string }).type).toBe('usage_update');
    expect(getRunSnapshot('PROGRESS')?.seq).toBe(1);
    expect(getRunSnapshot('PROGRESS')?.events.length).toBe(0);
    expect(getRunSnapshot('PROGRESS')?.outputTokens).toBe(42);
    offProgress();
  });

  it('rekey ADDS an alias: both keys resolve to the same run (race-safe)', () => {
    rekeyRun('S', 'S2');
    expect(getRunSnapshot('S')?.seq).toBe(2);
    expect(getRunSnapshot('S2')?.seq).toBe(2);
  });

  it('a listener on the OLD key keeps receiving after rekey (fanout covers aliases)', () => {
    appendRun('S2', { type: 'assistant', uuid: 'u3' });
    expect(got.length).toBe(3);
    expect(got[2].seq).toBe(3);
    expect(getRunSnapshot('S2')?.events.length).toBe(3);
  });

  it('markRunIdle: not active, snapshot kept within grace', () => {
    markRunIdle('S2', 'idle');
    expect(isRunActive('S2')).toBe(false);
    expect(getRunSnapshot('S2')?.status).toBe('idle');
  });

  it('markRunIdle fans out a one-time run-ended (seq bumped 3→4 for snapshot dedupe)', () => {
    expect(got.length).toBe(4);
    expect((got[3].message as { type?: string }).type).toBe('run-ended');
    expect(got[3].seq).toBe(4);
  });

  it('writer release is sequenced before the next turn and clears events', () => {
    releaseRun('S2'); // the previous turn's engine has exited (the orchestrator does this)
    expect((got.at(-1)?.message as { type: string }).type).toBe('run-settled');
    startRun('S2', '/cwd');
    expect(getRunSnapshot('S2')?.seq).toBe(5);
    expect(getRunSnapshot('S2')?.events.length).toBe(0);
  });

  it('separates Stop from final writer release across aliases and reconnect snapshots', () => {
    const events: Array<{ seq: number; message: unknown }> = [];
    startRun('settle-provisional', '/cwd', 'prompt', 'settle-run');
    rekeyRun('settle-provisional', 'settle-session');
    const offSettled = addRunListener('settle-provisional', (event) => events.push(event));
    requestStop('settle-session');
    expect(getRunSnapshot('settle-session')?.writerActive).toBe(true);
    expect(events.at(-1)?.message).toMatchObject({ type: 'run-ended', writerActive: true, runId: 'settle-run' });
    const stopSeq = events.at(-1)!.seq;
    releaseRun('settle-session');
    expect(getRunSnapshot('settle-provisional')?.writerActive).toBe(false);
    expect(events.at(-1)).toMatchObject({ seq: stopSeq + 1, message: { type: 'run-settled', runId: 'settle-run' } });
    releaseRun('settle-session');
    expect(events.filter((event) => (event.message as { type: string }).type === 'run-settled')).toHaveLength(1);
    offSettled();
  });

  it('unsubscribe is robust to the prior rekey', () => {
    off();
    const before = got.length;
    appendRun('S2', { type: 'assistant', uuid: 'u5' });
    expect(got.length).toBe(before);
  });

  it('startRun(promptText) seeds a synthetic human-user event (snapshot + live fan-out)', () => {
    const pgot: Array<{ seq: number; message: unknown }> = [];
    const poff = addRunListener('P', (ev) => pgot.push(ev));
    startRun('P', '/cwd', 'hello world');
    const psnap = getRunSnapshot('P');
    const pmsg = psnap?.events[0] as
      | { type?: string; _human?: boolean; message?: { content?: unknown } }
      | undefined;
    expect(psnap?.events.length).toBe(1);
    expect(pmsg?.type).toBe('user');
    expect(pmsg?._human).toBe(true);
    expect(pmsg?.message?.content).toBe('hello world');
    expect(pgot.length).toBe(1);
    expect(pgot[0].seq).toBe(1);
    poff();
  });

  // R1 terminal-precedence: an engine's error path marks 'error', then its process-close
  // handler marks 'idle'. The second call must NOT downgrade — else a failed turn reads as
  // success (scheduled tasks poll getRunSnapshot().status).
  it('markRunIdle: error is sticky, a later idle does not downgrade it', () => {
    startRun('E', '/cwd');
    markRunIdle('E', 'error');
    expect(getRunSnapshot('E')?.status).toBe('error');
    markRunIdle('E', 'idle'); // close handler, must be ignored
    expect(getRunSnapshot('E')?.status).toBe('error');
  });

  it('markRunIdle: a late error upgrades an idle run (fail closed)', () => {
    startRun('U', '/cwd');
    markRunIdle('U', 'idle');
    expect(getRunSnapshot('U')?.status).toBe('idle');
    markRunIdle('U', 'error');
    expect(getRunSnapshot('U')?.status).toBe('error');
  });

  it('markRunIdle fires run-ended exactly once (second call is a no-op)', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    startRun('O', '/cwd');
    const off2 = addRunListener('O', (ev) => evs.push(ev));
    markRunIdle('O', 'idle');
    markRunIdle('O', 'idle');
    markRunIdle('O', 'error');
    const ended = evs.filter(
      (e) => (e.message as { type?: string })?.type === 'run-ended'
    );
    expect(ended.length).toBe(1);
    off2();
  });

  // R1: late model output cannot resume a terminal run while its writer drains.
  it('appendRun drops model output once the run is terminal', () => {
    const evs: Array<{ seq: number; message: unknown }> = [];
    startRun('L', '/cwd');
    const off3 = addRunListener('L', (ev) => evs.push(ev));
    appendRun('L', { type: 'assistant', uuid: 'live' }); // running → delivered
    markRunIdle('L', 'idle');
    const before = getRunSnapshot('L')?.events.length ?? 0;
    appendRun('L', { type: 'assistant', uuid: 'late' }); // terminal → dropped
    expect(getRunSnapshot('L')?.events.length).toBe(before);
    const lateDelivered = evs.some(
      (e) => (e.message as { uuid?: string })?.uuid === 'late'
    );
    expect(lateDelivered).toBe(false);
    off3();
  });

  // R2: seq must survive eviction. A viewer that joined mid-prior-turn has a high snapshotSeq;
  // if the next turn's seq reset to 0 after the grace window, `seq > snapshotSeq` would filter
  // the whole turn out and the viewer would silently miss it. (The old test never advanced the
  // 60s evict timer, so it couldn't catch this.)
  it('seq does not reset across eviction (the grace-window viewer keeps receiving)', () => {
    vi.useFakeTimers();
    try {
      startRun('EV', '/cwd');
      appendRun('EV', { type: 'assistant', uuid: 'a' });
      markRunIdle('EV', 'idle'); // bumps seq (run-ended) + schedules the 60s evict
      releaseRun('EV'); // engine exited: nothing holds the entry past the grace window
      const seqAtIdle = getRunSnapshot('EV')!.seq;
      expect(seqAtIdle).toBeGreaterThan(0);

      vi.advanceTimersByTime(60_001); // evict fires → registry drops 'EV'
      expect(getRunSnapshot('EV')).toBeNull();

      startRun('EV', '/cwd'); // next turn under the SAME key, AFTER eviction
      expect(getRunSnapshot('EV')!.seq).toBe(seqAtIdle); // resumed, NOT reset to 0
      appendRun('EV', { type: 'assistant', uuid: 'b' });
      expect(getRunSnapshot('EV')!.seq).toBe(seqAtIdle + 1); // strictly increasing across eviction
    } finally {
      vi.useRealTimers();
    }
  });
  it('writer lease: a stopped run keeps the session busy until its engine exits', async () => {
    vi.useFakeTimers();
    try {
      startRun('W', '/cwd');
      markRunIdle('W', 'idle'); // Stop: the UI is done…
      expect(isRunActive('W')).toBe(false);
      expect(isSessionBusy('W')).toBe(true); // …but the engine still writes
      expect(startRun('W', '/cwd')).toBe(false); // no second writer

      vi.advanceTimersByTime(60_001); // grace window passes: the lease must not be evicted
      expect(isSessionBusy('W')).toBe(true);

      const freed = waitForWriter('W', 10_000);
      releaseRun('W'); // engine exited
      await expect(freed).resolves.toBe(true);
      expect(isSessionBusy('W')).toBe(false);
      expect(startRun('W', '/cwd')).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  it('waitForWriter gives up after its timeout while the lease is held', async () => {
    vi.useFakeTimers();
    try {
      startRun('T', '/cwd');
      markRunIdle('T', 'idle');
      const freed = waitForWriter('T', 1000);
      vi.advanceTimersByTime(1001);
      await expect(freed).resolves.toBe(false);
      releaseRun('T');
    } finally {
      vi.useRealTimers();
    }
  });
});


describe('failed run recovery lifetime', () => {
  it('retains failure through successor admission, then expires independently', () => {
    vi.useFakeTimers();
    try {
      startRun('recovery-session', '/cwd', 'Prompt', 'failed-run');
      appendRun('recovery-session', { type: 'error', error: 'Failed' });
      markRunIdle('recovery-session', 'error');
      vi.advanceTimersByTime(40_000);
      releaseRun('recovery-session');
      startRun('recovery-session', '/cwd', 'Next', 'successor');
      vi.advanceTimersByTime(59_999);
      expect(getRunRecoveries('recovery-session')).toMatchObject([{ runId: 'failed-run', recovery: true, writerActive: false }]);
      expect(getRunSnapshot('recovery-session')?.runId).toBe('successor');
      expect(getRunSnapshot('recovery-session')?.writerActive).toBe(true);
      vi.advanceTimersByTime(2);
      expect(getRunRecoveries('recovery-session')).toEqual([]);
      expect(getRunSnapshot('recovery-session')?.runId).toBe('successor');
      markRunIdle('recovery-session'); releaseRun('recovery-session');
      vi.advanceTimersByTime(60_001);
    } finally { vi.useRealTimers(); }
  });

  it('includes deletion evidence in reconnect replay and sequences it after current events', () => {
    startRun('recovery-delete', '/cwd', 'Prompt', 'deleted-failure');
    rekeyRun('recovery-delete', 'recovery-delete-session');
    markRunIdle('recovery-delete-session', 'error'); releaseRun('recovery-delete-session');
    startRun('recovery-delete-session', '/cwd', 'Next', 'following-run');
    const before = getRunSnapshot('recovery-delete-session')!.seq;
    const events: unknown[] = [];
    const off = addRunListener('recovery-delete-session', (event) => events.push(event));
    const deletion = { sourceIds: ['native-input'], taskIds: ['task-id'] };
    deleteRunRecoveryTurns('recovery-delete-session', deletion);
    off();
    expect(events).toMatchObject([{ seq: before + 1, message: { type: 'recovery-deleted', deletion } }]);
    expect(getRunRecoveries('recovery-delete-session')[0].recoveryDeletions).toEqual([deletion]);
    expect(getRunRecoveries('recovery-delete')[0].recoveryDeletions).toEqual([deletion]);
    markRunIdle('recovery-delete-session'); releaseRun('recovery-delete-session');
  });
});

it('keeps ordered identity remaps and deletion across aliases, expiry and successors', () => {
  vi.useFakeTimers();
  try {
    const first = { sourceIds: ['removed'], taskIds: [], sourceRemap: { a: 'b' } };
    const second = { sourceIds: [], taskIds: [], sourceRemap: { b: 'c' } };
    const last = { sourceIds: ['c'], taskIds: [] };
    // Both keys can already have edit evidence before becoming aliases.
    deleteRunRecoveryTurns('journal-native', first);
    deleteRunRecoveryTurns('journal-provisional', second);
    startRun('journal-provisional', '/cwd', 'prompt', 'journal-run');
    rekeyRun('journal-provisional', 'journal-native');
    rekeyRun('journal-provisional', 'journal-native');
    markRunIdle('journal-native', 'error'); releaseRun('journal-native');
    vi.advanceTimersByTime(60_001);
    const events: Array<{ seq: number }> = [];
    const off = addRunListener('journal-provisional', event => events.push(event));
    deleteRunRecoveryTurns('journal-native', last);
    off();
    expect(events).toHaveLength(1);
    expect(getRecoveryDeletions('journal-native')).toEqual([first, second, last]);
    expect(getRecoveryDeletions('journal-provisional')).toEqual([first, second, last]);
    expect(getRecoveryDeletions('unrelated-journal')).toEqual([]);
    startRun('journal-native', '/cwd', 'next');
    expect(getRunSnapshot('journal-native')).toMatchObject({ recoveryDeletions: [first, second, last] });
    expect(getRunSnapshot('journal-native')!.seq).toBeGreaterThan(events[0].seq);
    deleteRunRecoveryTurns('journal-provisional', { sourceIds: ['later-input'], taskIds: [] });
    const afterAliasDeletion = getRunSnapshot('journal-native')!.seq;
    appendRun('journal-native', { type: 'assistant', message: { content: 'Next output' } });
    expect(getRunSnapshot('journal-native')!.seq).toBeGreaterThan(afterAliasDeletion);
    markRunIdle('journal-native'); releaseRun('journal-native'); vi.advanceTimersByTime(60_001);
  } finally { vi.useRealTimers(); }
});


it('keeps undelivered input settlement after Stop inline, without failing the run', () => {
  const key = 'stopped-input-recovery';
  startRun(key, '/cwd', 'Initial', key, 'ollama');
  const received: unknown[] = [];
  const off = addRunListener(key, event => received.push(event.message));
  requestStop(key);
  appendRun(key, { type: 'error', error: 'Late generic error' });
  const binding = { type: 'system', subtype: 'input_binding', inputId: key, sourceId: 'native-input' };
  appendRun(key, binding);
  expect(getRunSnapshot(key)?.status).toBe('idle');
  expect(received).toContainEqual(binding);
  const recovery = { type: 'error', error: 'Input cancelled', undeliveredInputs: [{ inputId: 'queued', images: [{ type: 'base64', media_type: 'image/png', data: 'image' }] }] };
  appendRun(key, recovery);
  expect(getRunSnapshot(key)).toMatchObject({ status: 'idle', writerActive: true });
  expect(received).toContainEqual(recovery);
  expect(received).not.toContainEqual({ type: 'error', error: 'Late generic error' });
  releaseRun(key);
  expect(received.at(-1)).toMatchObject({ type: 'run-settled', status: 'idle' });
  const count = getRunSnapshot(key)!.events.length;
  appendRun(key, recovery);
  appendRun(key, binding);
  expect(getRunSnapshot(key)!.events).toHaveLength(count);
  startRun(key, '/cwd', 'Successor', 'next');
  expect(getRunRecoveries(key)).toEqual([]);
  off(); markRunIdle(key); releaseRun(key);
});

it('compacts a journal over the entry cap into one invalidation marker instead of truncating', () => {
  const key = 'journal-bounded-entries';
  const before = Date.now();
  for (let i = 0; i < MAX_RECOVERY_DELETIONS + 20; i++) deleteRunRecoveryTurns(key, { sourceIds: [`s${i}`], taskIds: [] });
  const kept = getRecoveryDeletions(key);
  // Entry 101 compacted the journal; the 19 later deletions stay precise.
  expect(kept).toHaveLength(20);
  expect(kept[0]).toEqual({ sourceIds: [], taskIds: [], clearsBefore: expect.any(Number) });
  expect(kept[0].clearsBefore).toBeGreaterThanOrEqual(before);
  expect(kept.slice(1).map(d => d.sourceIds[0])).toEqual(Array.from({ length: 19 }, (_, i) => `s${MAX_RECOVERY_DELETIONS + 1 + i}`));
  expect(kept.some(d => d.sourceIds.includes('s0'))).toBe(false);
});

it('compacts a single deletion that exceeds the per-session ID budget', () => {
  const key = 'journal-bounded-ids';
  const many = Array.from({ length: MAX_RECOVERY_IDS_PER_SESSION + 500 }, (_, i) => `n${i}`);
  const sourceRemap = Object.fromEntries(many.map(id => [id, `${id}'`]));
  const received: unknown[] = [];
  const off = addRunListener(key, event => received.push(event.message));
  deleteRunRecoveryTurns(key, { sourceIds: ['removed'], taskIds: [], sourceRemap });
  off();
  // Connected viewers still get the precise deletion live...
  expect(received).toEqual([{ type: 'recovery-deleted', deletion: expect.objectContaining({ sourceRemap }) }]);
  // ...while the retained evidence replayed to reconnecting clients stays small.
  expect(getRecoveryDeletions(key)).toEqual([{ sourceIds: [], taskIds: [], clearsBefore: expect.any(Number) }]);
  expect(JSON.stringify(getRecoveryDeletions(key)).length).toBeLessThan(200);
});

it('compacts merged aliases that together exceed the per-session ID budget', () => {
  const half = (prefix: string) => ({ sourceIds: Array.from({ length: MAX_RECOVERY_IDS_PER_SESSION * 0.75 }, (_, i) => `${prefix}${i}`), taskIds: [] });
  deleteRunRecoveryTurns('journal-merge-native', half('a'));
  deleteRunRecoveryTurns('journal-merge-provisional', half('b'));
  startRun('journal-merge-provisional', '/cwd', 'prompt', 'journal-merge-run');
  rekeyRun('journal-merge-provisional', 'journal-merge-native');
  expect(getRecoveryDeletions('journal-merge-provisional')).toEqual([{ sourceIds: [], taskIds: [], clearsBefore: expect.any(Number) }]);
  markRunIdle('journal-merge-native'); releaseRun('journal-merge-native');
});

it('compacts the least recently used journals when the global ID budget is exceeded', () => {
  const per = MAX_RECOVERY_IDS_PER_SESSION - 100;
  const sessions = Math.ceil(MAX_RECOVERY_IDS_TOTAL / per) + 1;
  for (let i = 0; i < sessions; i++) {
    deleteRunRecoveryTurns(`journal-global-${i}`, { sourceIds: Array.from({ length: per }, (_, j) => `g${i}-${j}`), taskIds: [] });
  }
  expect(getRecoveryDeletions('journal-global-0')).toEqual([{ sourceIds: [], taskIds: [], clearsBefore: expect.any(Number) }]);
  expect(getRecoveryDeletions(`journal-global-${sessions - 1}`)[0].sourceIds).toHaveLength(per);
});

it('evicts the least recently used recovery journals with all their aliases', () => {
  deleteRunRecoveryTurns('journal-lru-old', { sourceIds: ['old'], taskIds: [] });
  startRun('journal-lru-old-provisional', '/cwd', 'prompt', 'journal-lru-run');
  rekeyRun('journal-lru-old-provisional', 'journal-lru-old');
  markRunIdle('journal-lru-old'); releaseRun('journal-lru-old');
  deleteRunRecoveryTurns('journal-lru-kept', { sourceIds: ['kept'], taskIds: [] });
  for (let i = 0; i < MAX_RECOVERY_JOURNALS; i++) {
    deleteRunRecoveryTurns(`journal-lru-filler-${i}`, { sourceIds: ['x'], taskIds: [] });
    // Recent use protects a journal regardless of when it was created.
    if (i === 0) deleteRunRecoveryTurns('journal-lru-kept', { sourceIds: ['kept-again'], taskIds: [] });
  }
  expect(getRecoveryDeletions('journal-lru-old')).toEqual([]);
  expect(getRecoveryDeletions('journal-lru-old-provisional')).toEqual([]);
  expect(getRecoveryDeletions('journal-lru-kept').map(d => d.sourceIds[0])).toEqual(['kept', 'kept-again']);
  expect(getRecoveryDeletions(`journal-lru-filler-${MAX_RECOVERY_JOURNALS - 1}`)).toHaveLength(1);
});
