import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunCtx } from '../types';

// The mock query() replays a scripted message stream, then drains the host's input generator.
// That drain only completes once runSdkLoop calls closeInput(), so "did the gate close?" — the
// single thing this file pins — is observable as: did the drain finish, or did it hang?
const h = vi.hoisted(() => ({
  script: [] as Array<Record<string, unknown>>,
  closed: false,
  yielded: [] as unknown[],
}));

// A script entry with `stamp: true` is emitted as a reply to the seeded user turn: it carries
// that message's uuid as `user_message_uuid`, the way the CLI binds a turn to its prompt.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) =>
    (async function* () {
      const it = prompt[Symbol.asyncIterator]();
      const first = await it.next();
      if (!first.done) h.yielded.push(first.value);
      const firstUuid = first.done ? undefined : first.value.uuid;
      for (const { stamp, ...m } of h.script) yield stamp ? { ...m, user_message_uuid: firstUuid } : m;
      /* drain: blocks on the gate */
      for (let r = await it.next(); !r.done; r = await it.next()) h.yielded.push(r.value);
      h.closed = true;
    })(),
}));

const { runSdkLoop } = await import('./sdkLoop');

type InputSink = Parameters<RunCtx['acceptInput']>[0];
let sink: InputSink = null;

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
    acceptInput: (s) => { sink = s; },
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
/** The first reply frame of the turn answering our seeded message. */
const reply = { type: 'assistant', stamp: true };
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
    h.yielded = [];
    sink = null;
  });

  it('closes on result when no background task is running', async () => {
    expect(await gateClosed([reply, result])).toBe(true);
  });

  it('stays resident while a real background task is still running', async () => {
    expect(await gateClosed([reply, started('t1'), result])).toBe(false);
  });

  it('does NOT let an ambient (housekeeping) task hold the session open', async () => {
    // Ambient tasks — skip_transcript work, auto-started live-update watchers — can outlive the
    // turn indefinitely. Counting one would keep every session resident forever.
    expect(await gateClosed([reply, started('t1', true), result])).toBe(true);
  });

  it('lets the level signal clear a set wedged by a missed task_notification', async () => {
    // The edge bookends alone would leave t1 pending forever; background_tasks_changed replaces
    // the whole set, so a dropped notification cannot wedge the process resident.
    expect(await gateClosed([reply, started('t1'), level([]), result])).toBe(true);
  });

  it('honours a live non-ambient task reported only by the level signal', async () => {
    expect(await gateClosed([reply, level([{ task_id: 't1' }]), result])).toBe(false);
  });

  it('ignores ambient entries inside the level payload', async () => {
    expect(await gateClosed([reply, level([{ task_id: 't1', ambient: true }]), result])).toBe(true);
  });

  it('does not close on a turn the CLI queued ahead of our prompt', async () => {
    // Resume: the CLI first answers its own notification about tasks the previous process left
    // behind. That result is not ours — closing on it would end the input before our prompt ran.
    expect(await gateClosed([result])).toBe(false);
    expect(await gateClosed([result, reply, result])).toBe(true);
  });

  it('stops waiting for a stamp after a few results, so a silent CLI cannot wedge the run', async () => {
    expect(await gateClosed([result, result])).toBe(false);
    expect(await gateClosed([result, result, result])).toBe(true);
  });
});

describe('runSdkLoop mid-run input', () => {
  beforeEach(() => {
    h.script = [];
    h.closed = false;
    h.yielded = [];
    sink = null;
  });

  it('passes a message sent while resident on to the CLI as priority next', async () => {
    expect(await gateClosed([reply, started('t1'), result])).toBe(false);
    expect(sink?.({ text: 'also do X' })).toBe(true);
    await new Promise((r) => setTimeout(r, 0));
    expect(h.yielded).toHaveLength(2);
    expect(h.yielded[1]).toMatchObject({
      uuid: expect.any(String),
      type: 'user',
      message: { role: 'user', content: 'also do X' },
      priority: 'next',
    });
    // Taking input does not close the stream: the background task still holds it open.
    expect(h.closed).toBe(false);
  });

  it('refuses input once the stream has closed, so the caller opens a new run', async () => {
    expect(await gateClosed([reply, result])).toBe(true);
    // The loop withdraws its sink when it returns; a sink captured earlier also refuses.
    expect(sink).toBeNull();
  });

  it('refuses input captured before the close', async () => {
    h.script = [reply, started('t1'), level([]), result];
    let captured: InputSink = null;
    const done = runSdkLoop(
      { ...makeCtx(), acceptInput: (s) => { if (s) captured = s; } },
      () => ({}),
    );
    await Promise.race([done, new Promise((r) => setTimeout(r, 50))]);
    expect(h.closed).toBe(true);
    expect(captured).not.toBeNull();
    expect(captured!({ text: 'too late' })).toBe(false);
  });
});
