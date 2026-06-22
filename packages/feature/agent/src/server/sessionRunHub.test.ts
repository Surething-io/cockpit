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
  addRunListener,
} from './sessionRunHub';

describe('sessionRunHub (#10 run registry)', () => {
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

  it('new turn keeps seq monotonic (4, never resets) and clears events', () => {
    startRun('S2', '/cwd');
    expect(getRunSnapshot('S2')?.seq).toBe(4);
    expect(getRunSnapshot('S2')?.events.length).toBe(0);
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

  // R1 appendRun guard: a late engine event after the run reached a terminal state must not
  // fan out (the viewer already finalized its bubble on run-ended).
  it('appendRun is a no-op once the run is terminal', () => {
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
});
