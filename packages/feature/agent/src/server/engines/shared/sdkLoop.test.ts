import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunCtx } from '../types';

// The mock query() replays a scripted message stream, then drains the host's input generator.
// That drain only completes once runSdkLoop calls closeInput(), so "did the gate close?" — the
// single thing this file pins — is observable as: did the drain finish, or did it hang?
const h = vi.hoisted(() => ({ script: [] as Array<Record<string, unknown>>, closed: false }));

vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<unknown> }) =>
    (async function* () {
      for (const m of h.script) yield m;
      for await (const _ of prompt) {
        /* drain: yields the seeded user turn, then blocks on the gate */
      }
      h.closed = true;
    })(),
}));

const { runSdkLoop } = await import('./sdkLoop');

function makeCtx(): RunCtx {
  return {
    prompt: 'hi',
    images: undefined,
    cwd: '/tmp',
    sessionId: 's1',
    params: {} as RunCtx['params'],
    signal: new AbortController().signal,
    emit: () => {},
    rekey: () => {},
    currentKey: () => 's1',
  };
}

/** Run the loop with `script`; resolve true if the input gate closed, false if it stayed open. */
async function gateClosed(script: Array<Record<string, unknown>>): Promise<boolean> {
  h.script = script;
  h.closed = false;
  const done = runSdkLoop(makeCtx(), () => ({}));
  const timeout = new Promise((r) => setTimeout(r, 50));
  await Promise.race([done, timeout]);
  return h.closed;
}

const result = { type: 'result' };
const started = (task_id: string, ambient?: boolean) => ({
  type: 'system',
  subtype: 'task_started',
  task_id,
  ...(ambient ? { ambient: true } : {}),
});
const level = (tasks: Array<{ task_id: string; ambient?: boolean }>) => ({
  type: 'system',
  subtype: 'background_tasks_changed',
  tasks,
});

describe('runSdkLoop background-task residency', () => {
  beforeEach(() => {
    h.script = [];
    h.closed = false;
  });

  it('closes on result when no background task is running', async () => {
    expect(await gateClosed([result])).toBe(true);
  });

  it('stays resident while a real background task is still running', async () => {
    expect(await gateClosed([started('t1'), result])).toBe(false);
  });

  it('does NOT let an ambient (housekeeping) task hold the session open', async () => {
    // Ambient tasks — skip_transcript work, auto-started live-update watchers — can outlive the
    // turn indefinitely. Counting one would keep every session resident forever.
    expect(await gateClosed([started('t1', true), result])).toBe(true);
  });

  it('lets the level signal clear a set wedged by a missed task_notification', async () => {
    // The edge bookends alone would leave t1 pending forever; background_tasks_changed replaces
    // the whole set, so a dropped notification cannot wedge the process resident.
    expect(await gateClosed([started('t1'), level([]), result])).toBe(true);
  });

  it('honours a live non-ambient task reported only by the level signal', async () => {
    expect(await gateClosed([level([{ task_id: 't1' }]), result])).toBe(false);
  });

  it('ignores ambient entries inside the level payload', async () => {
    expect(await gateClosed([level([{ task_id: 't1', ambient: true }]), result])).toBe(true);
  });
});
