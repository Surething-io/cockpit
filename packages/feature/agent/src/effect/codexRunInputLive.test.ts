import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import type { InjectedInput, RunCtx, RunEvent } from '../server/engines/types';
import { withCodexRunInput, type CodexRunInput } from './codexRunInputLive';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

function setup() {
  let sink: ((input: InjectedInput) => boolean) | null = null;
  let control!: CodexRunInput;
  const events: RunEvent[] = [];
  const done = gate();
  const abort = new AbortController();
  const ctx: RunCtx = {
    prompt: 'initial', images: undefined, cwd: '/repo', sessionId: undefined, params: {},
    rekey: vi.fn(), currentKey: () => 'run',
    signal: abort.signal,
    acceptInput: (next: typeof sink) => { sink = next; },
    emit: (event: RunEvent) => { events.push(event); },
  };
  const run = Effect.runPromise(withCodexRunInput(ctx, async (input) => {
    control = input;
    await done.promise;
  }));
  return { run, done, abort, events, get control() { return control; }, get sink() { return sink; } };
}

const tick = () => new Promise<void>((resolve) => setImmediate(resolve));

describe('Codex input lifecycle', () => {
  it('buffers startup input and serializes steering until each acknowledgement', async () => {
    const test = setup();
    await vi.waitFor(() => expect(test.control).toBeDefined());
    const first = gate();
    const send = vi.fn(async (input: InjectedInput) => { if (input.text === 'first') await first.promise; });
    expect(test.sink?.({ text: 'first' })).toBe(true);
    expect(test.sink?.({ text: 'second' })).toBe(true);
    expect(send).not.toHaveBeenCalled();
    test.control.open(send);
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(1));
    first.resolve();
    await vi.waitFor(() => expect(send).toHaveBeenCalledTimes(2));
    expect(send.mock.calls.map(([input]) => input.text)).toEqual(['first', 'second']);
    await tick();
    expect(test.events.filter((event) => event.notice === 'codex_input_accepted')).toHaveLength(2);
    test.done.resolve();
    await test.run;
    expect(test.sink).toBeNull();
  });

  it('reports rejection without terminating the active task or retrying the message', async () => {
    const test = setup();
    await vi.waitFor(() => expect(test.control).toBeDefined());
    const send = vi.fn().mockRejectedValueOnce(new Error('turn mismatch')).mockResolvedValueOnce(undefined);
    test.control.open(send);
    test.sink?.({ text: 'rejected' });
    test.sink?.({ text: 'next' });
    await vi.waitFor(() => expect(test.events.some((event) => event.notice === 'codex_input_accepted')).toBe(true));
    expect(send).toHaveBeenCalledTimes(2);
    expect(test.events).toContainEqual(expect.objectContaining({ notice: 'codex_input_failed', input_text: 'rejected', error: expect.stringContaining('turn mismatch') }));
    expect(test.sink).not.toBeNull();
    test.done.resolve();
    await test.run;
  });

  it('seals admission synchronously and reports unsent and unconfirmed input exactly once', async () => {
    const test = setup();
    await vi.waitFor(() => expect(test.control).toBeDefined());
    const ack = gate();
    const send = vi.fn(() => ack.promise);
    test.control.open(send);
    const staleSink = test.sink!;
    staleSink({ text: 'in flight' });
    staleSink({ text: 'queued' });
    await vi.waitFor(() => expect(send).toHaveBeenCalledOnce());
    test.control.close();
    expect(staleSink({ text: 'too late' })).toBe(false);
    expect(test.sink).toBeNull();
    ack.resolve();
    await tick();
    expect(test.events.filter((event) => event.notice === 'codex_input_failed')).toHaveLength(2);
    expect(test.events.filter((event) => event.notice === 'codex_input_accepted')).toHaveLength(0);
    expect(send).toHaveBeenCalledOnce();
    test.done.resolve();
    await test.run;
  });

  it('closes and reports startup input on cancellation', async () => {
    const test = setup();
    await vi.waitFor(() => expect(test.control).toBeDefined());
    test.sink?.({ text: 'pending during init' });
    test.abort.abort();
    expect(test.sink).toBeNull();
    expect(test.events).toContainEqual(expect.objectContaining({ notice: 'codex_input_failed', input_text: 'pending during init' }));
    test.done.resolve();
    await test.run;
  });
});
