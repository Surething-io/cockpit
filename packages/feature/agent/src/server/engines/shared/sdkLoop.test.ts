import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { RunCtx } from '../types';

// The mock query() replays a scripted message stream, then drains the host's input generator.
// The drain completes once runSdkLoop closes admission. Stamped frames also exercise
// consumption ownership through the production adapter, independently of the UI.
const h = vi.hoisted(() => ({
  script: [] as Array<Record<string, unknown>>,
  closed: false,
  yielded: [] as unknown[],
  transport: undefined as { process: { exitCode: number | null }; waitForExit: () => Promise<void> } | undefined,
}));

// A script entry with `stamp: true` is emitted as a reply to the seeded user turn: it carries
// that message's uuid as `user_message_uuid`, the way the CLI binds a turn to its prompt.
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: ({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) =>
    Object.assign((async function* () {
      const it = prompt[Symbol.asyncIterator]();
      const first = await it.next();
      if (!first.done) h.yielded.push(first.value);
      const firstUuid = first.done ? undefined : first.value.uuid;
      for (const { stamp, stampAll, takeInput, closeOutput, throwError, ...m } of h.script) {
        if (throwError) throw new Error('SDK failure');
        if (closeOutput) return;
        if (takeInput) { const next = await it.next(); if (!next.done) h.yielded.push(next.value); continue; }
        const uuid = stamp === true ? firstUuid : typeof stamp === 'number' ? (h.yielded[stamp] as { uuid?: string })?.uuid : undefined;
        yield { ...m, ...(uuid ? { user_message_uuid: uuid } : {}),
          ...(Array.isArray(stampAll) ? { user_message_uuids: stampAll.map(index => (h.yielded[index] as { uuid?: string }).uuid) } : {}) };
      }
      /* drain: blocks on the gate */
      for (let r = await it.next(); !r.done; r = await it.next()) h.yielded.push(r.value);
      h.closed = true;
    })(), { transport: h.transport }),
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

  it.each([false, true])('settles accepted input through dispatch after Stop (launch completed: %s)', async completed => {
    const { dispatchChat } = await import('../orchestrator');
    const hub = await import('../../sessionRunHub');
    const id = `sdk-stop-${completed}`;
    // Like the real CLI, init already carries the prompt's UUID in user_message_uuids.
    h.script = completed ? [reply, { type: 'result', stamp: true }, { type: 'assistant', text: 'stop here' }] : [{ type: 'system', subtype: 'init', stampAll: [0] }, reply];
    let queued = false;
    const image = { type: 'base64' as const, media_type: 'image/png' as const, data: 'image-bytes' };
    const off = hub.addRunListener(id, ({ message }) => {
      const event = message as { type: string; subtype?: string };
      if (!queued && event.type === (completed ? 'result' : 'system') && (completed || event.subtype === 'init')) {
        queued = true;
        expect(hub.injectRun(id, { text: 'queued', images: [image] }, 'queued-input')).toBe('ok');
        hub.requestStop(id);
      }
    });
    try {
      await dispatchChat({ name: 'claude', runner: { run: ctx => runSdkLoop(ctx, () => ({})) } }, { prompt: 'initial', runId: id });
      expect(await hub.waitForWriter(id, 1000)).toBe(true);
      const snapshot = hub.getRunSnapshot(id)!;
      expect(snapshot.status).toBe('error');
      const event = snapshot.events.find(value => (value as { undeliveredInputs?: unknown }).undeliveredInputs) as { undeliveredInputs: Array<{ inputId: string }> };
      expect(event.undeliveredInputs).toContainEqual({ inputId: 'queued-input', text: 'queued', images: [image] });
      // The initial prompt reached the CLI either way; only the queued input did not.
      expect(event.undeliveredInputs.some(input => input.inputId === id)).toBe(false);
    } finally { off(); hub.requestStop(id); await hub.waitForWriter(id, 1000); }
  });

  it('treats Stop mid-reply as a plain stop, not a failed run', async () => {
    const { dispatchChat } = await import('../orchestrator');
    const hub = await import('../../sessionRunHub');
    const id = 'sdk-stop-mid-reply';
    h.script = [{ type: 'system', subtype: 'init' }, reply, { type: 'assistant', text: 'never seen' }];
    const received: Array<{ type: string; status?: string; undeliveredInputs?: unknown }> = [];
    let stopped = false;
    const off = hub.addRunListener(id, ({ message }) => {
      const event = message as { type: string; user_message_uuid?: string };
      received.push(event);
      if (!stopped && event.type === 'assistant' && event.user_message_uuid) { stopped = true; hub.requestStop(id); }
    });
    try {
      await dispatchChat({ name: 'claude', runner: { run: ctx => runSdkLoop(ctx, () => ({})) } }, { prompt: 'initial', runId: id });
      expect(await hub.waitForWriter(id, 1000)).toBe(true);
      expect(stopped).toBe(true);
      expect(hub.getRunSnapshot(id)).toMatchObject({ status: 'idle', writerActive: false });
      expect(received.some(event => event.undeliveredInputs)).toBe(false);
      expect(received.find(event => event.type === 'run-settled')).toMatchObject({ status: 'idle' });
      expect(hub.startRun(id, '', 'Successor', `${id}-next`)).toBe(true);
      expect(hub.getRunRecoveries(id)).toEqual([]);
    } finally { off(); hub.markRunIdle(id); hub.releaseRun(id); }
  });

  it('reports a queued input the SDK pulls after Stop but never writes', async () => {
    // Mirrors the SDK's streamInput: it pulls the next prompt message, then drops it
    // without writing when the query's abort controller has already fired.
    const written: Array<{ uuid?: string }> = [];
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const spy = vi.spyOn(sdk, 'query').mockImplementation((({ prompt, options }: {
      prompt: AsyncIterable<{ uuid?: string }>; options: { abortController: AbortController };
    }) => {
      const it = prompt[Symbol.asyncIterator]();
      const firstWritten = (async () => {
        const first = await it.next();
        if (!first.done) written.push(first.value);
        void (async () => {
          for (let next = await it.next(); !next.done; next = await it.next()) {
            if (options.abortController.signal.aborted) return;
            written.push(next.value);
          }
        })();
      })();
      return Object.assign((async function* () {
        await firstWritten;
        yield { type: 'system', subtype: 'init', user_message_uuids: [written[0]?.uuid] };
        yield { type: 'assistant', user_message_uuid: written[0]?.uuid };
        yield { type: 'assistant', text: 'after stop' };
      })(), { transport: undefined });
    }) as unknown as typeof sdk.query);
    const abort = new AbortController();
    const ctx = { ...makeCtx(), signal: abort.signal }; ctx.params.runId = 'pulled-after-stop';
    const events: Array<Record<string, unknown>> = [];
    ctx.emit = event => {
      events.push(event);
      if (event.subtype === 'init') {
        expect(sink?.({ inputId: 'queued-at-stop', text: 'queued' })).toBe(true);
        abort.abort();
      }
    };
    try {
      await runSdkLoop(ctx, (ac) => ({ abortController: ac }));
    } finally { spy.mockRestore(); }
    expect(written).toHaveLength(1);
    expect(events).not.toContainEqual(expect.objectContaining({ subtype: 'input_binding', inputId: 'queued-at-stop' }));
    expect(events.find(event => event.undeliveredInputs)).toMatchObject({
      undeliveredInputs: [{ inputId: 'queued-at-stop', text: 'queued' }],
    });
  });

  it('counts a stamp the SDK buffered before Stop, even though the host reads it after', async () => {
    // The SDK reads CLI output into its own queue independently of the host loop, so a
    // stamped init can already be buffered when Stop fires and only be read afterwards.
    const abort = new AbortController();
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const spy = vi.spyOn(sdk, 'query').mockImplementation((({ prompt }: { prompt: AsyncIterable<{ uuid?: string }> }) =>
      Object.assign((async function* () {
        const first = await prompt[Symbol.asyncIterator]().next();
        const uuid = first.done ? undefined : first.value.uuid;
        abort.abort();
        yield { type: 'system', subtype: 'init', user_message_uuids: [uuid] };
        yield { type: 'assistant', text: 'never read' };
      })(), { transport: undefined })) as unknown as typeof sdk.query);
    const ctx = { ...makeCtx(), signal: abort.signal }; ctx.params.runId = 'stamp-buffered-before-stop';
    const events: Array<Record<string, unknown>> = [];
    ctx.emit = event => events.push(event);
    try {
      await runSdkLoop(ctx, () => ({}));
    } finally { spy.mockRestore(); }
    expect(events.some(event => event.undeliveredInputs)).toBe(false);
  });

  it('reports a queued input the CLI received but had not dequeued when Stop fired', async () => {
    // Verified against the real CLI: an input pulled while a reply streams is only
    // enqueued; Stop leaves a `queue-operation` line and never a user row for it.
    const abort = new AbortController();
    const ctx = { ...makeCtx(), signal: abort.signal }; ctx.params.runId = 'stop-before-dequeue';
    const events: Array<Record<string, unknown>> = [];
    ctx.emit = event => {
      events.push(event);
      if (event.type === 'assistant' && event.user_message_uuid) expect(sink?.({ inputId: 'enqueued-only', text: 'queued' })).toBe(true);
      if (event.type === 'assistant' && event.text === 'still answering the first prompt') abort.abort();
    };
    h.script = [{ type: 'system', subtype: 'init' }, reply, { takeInput: true },
      { type: 'assistant', text: 'still answering the first prompt' }, { type: 'assistant', text: 'never seen' }];
    await runSdkLoop(ctx, () => ({})).catch(() => {});
    // The SDK did receive the queued input...
    expect(h.yielded).toHaveLength(2);
    // ...but it was never stamped, so Stop reports it while the stamped prompt is not.
    expect(events.find(event => event.undeliveredInputs)).toMatchObject({
      undeliveredInputs: [{ inputId: 'enqueued-only', text: 'queued' }],
    });
  });

  it('still reports the initial prompt when Stop lands before the CLI takes it', async () => {
    const abort = new AbortController(); abort.abort();
    const ctx = { ...makeCtx(), signal: abort.signal }; ctx.params.runId = 'stop-before-delivery';
    const events: Array<Record<string, unknown>> = [];
    ctx.emit = event => events.push(event);
    // The SDK ends without ever pulling the prompt generator.
    const sdk = await import('@anthropic-ai/claude-agent-sdk');
    const spy = vi.spyOn(sdk, 'query').mockImplementation((() =>
      Object.assign((async function* () { /* never pulls the prompt */ })(), { transport: undefined })) as unknown as typeof sdk.query);
    try {
      await runSdkLoop(ctx, () => ({}));
    } finally { spy.mockRestore(); }
    expect(events.some(event => event.subtype === 'input_binding')).toBe(false);
    expect(events.find(event => event.undeliveredInputs)).toMatchObject({
      error: expect.stringContaining('cancelled'),
      undeliveredInputs: [{ inputId: 'stop-before-delivery', text: 'hi' }],
    });
  });

  it('settles input and closes admission when SDK iteration throws', async () => {
    h.script = [{ type: 'system', subtype: 'init' }, { throwError: true }];
    const events: Array<Record<string, unknown>> = [];
    const ctx = makeCtx(); ctx.params.runId = 'failed-launch';
    ctx.emit = event => {
      events.push(event);
      if (event.subtype === 'init') expect(sink?.({ inputId: 'failed-queued', text: 'queued' })).toBe(true);
    };
    let exit!: () => void;
    let waiting!: () => void;
    const childExit = new Promise<void>(resolve => { exit = resolve; });
    const waitingForExit = new Promise<void>(resolve => { waiting = resolve; });
    h.transport = { process: { exitCode: null }, waitForExit: () => { waiting(); return childExit; } };
    const done = runSdkLoop(ctx, () => ({}));
    const rejected = expect(done).rejects.toThrow('SDK failure');
    try {
      await waitingForExit;
      expect(sink?.({ inputId: 'too-late', text: 'late' })).toBe(false);
      expect(events.some(event => event.undeliveredInputs)).toBe(false);
      exit();
      await rejected;
      expect(sink).toBeNull();
      expect(events.find(event => event.undeliveredInputs)).toMatchObject({ undeliveredInputs: [
        { inputId: 'failed-launch', text: 'hi' }, { inputId: 'failed-queued', text: 'queued' },
      ] });
    } finally { exit(); h.transport = undefined; }
  });

  it('fails and settles accepted inputs when result-less retries are exhausted', async () => {
    h.script = [{ type: 'system', subtype: 'init' }, { closeOutput: true }];
    const ctx = makeCtx(); ctx.params.runId = 'eof-launch';
    const events: Array<Record<string, unknown>> = [];
    const queued = { inputId: 'eof-queued', text: 'queued', images: [{ type: 'base64' as const, media_type: 'image/png' as const, data: 'image' }] };
    let admitted = false;
    ctx.emit = event => {
      events.push(event);
      if (event.subtype === 'init' && !admitted) { admitted = true; expect(sink?.(queued)).toBe(true); }
    };
    await expect(runSdkLoop(ctx, () => ({}))).rejects.toThrow('without a result');
    expect(h.yielded).toHaveLength(2);
    expect(sink).toBeNull();
    expect(events.find(event => event.undeliveredInputs)).toMatchObject({ undeliveredInputs: [
      { inputId: 'eof-launch', text: 'hi' }, queued,
    ] });
  });

  it('binds admission identities to the UUIDs delivered to the SDK', async () => {
    h.script = [reply, result];
    const events: unknown[] = [];
    const context = makeCtx();
    context.params.runId = 'launch';
    context.emit = (event) => events.push(event);
    context.acceptInput = (input) => { if (input) input({ text: 'queued', inputId: 'queued' }); };
    await runSdkLoop(context, () => ({}));
    const inputs = h.yielded as Array<{ uuid: string }>;
    expect(inputs).toHaveLength(2);
    expect(events.filter((event) => (event as { subtype?: string }).subtype === 'input_binding')).toEqual([
      { type: 'system', subtype: 'input_binding', inputId: 'launch', sourceId: inputs[0].uuid },
      { type: 'system', subtype: 'input_binding', inputId: 'queued', sourceId: inputs[1].uuid },
    ]);
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


it.each([
  { subtype: 'success', result: 'API capacity failure', is_error: true },
  { subtype: 'error_during_execution', errors: ['Provider failed', 'Please retry'], is_error: true },
  { subtype: 'error_max_turns', errors: [], is_error: true },
])('retains SDK error result $subtype after the writer exits', async (failure) => {
  const { dispatchChat } = await import('../orchestrator');
  const hub = await import('../../sessionRunHub');
  const id = `sdk-error-${failure.subtype}`;
  let exit!: () => void;
  const exited = new Promise<void>((resolve) => { exit = resolve; });
  h.closed = false;
  h.transport = { process: { exitCode: null }, waitForExit: () => exited };
  h.script = [failure.subtype === 'success' ? reply : started('unfinished-task'), { type: 'result', ...failure }];
  try {
    const outcome = await dispatchChat({ name: 'fake', runner: { run: (ctx) => runSdkLoop(ctx, () => ({})) } },
      { prompt: 'Keep my work', runId: id });
    expect(outcome.ok).toBe(true);
    await vi.waitFor(() => expect(h.closed).toBe(true));
    expect(hub.getRunSnapshot(id)).toMatchObject({ status: 'running', writerActive: true });
    h.transport.process.exitCode = 0; exit();
    expect(await hub.waitForWriter(id, 5000)).toBe(true);
    const message = failure.errors?.join('\n') || failure.result || failure.subtype;
    expect(hub.getRunSnapshot(id)).toMatchObject({ status: 'error', writerActive: false });
    expect(hub.getRunSnapshot(id)?.events).toContainEqual(expect.objectContaining({ type: 'error', error: message }));
    expect(hub.startRun(id, '', 'Successor', `${id}-next`)).toBe(true);
    expect(hub.getRunRecoveries(id)).toEqual([expect.objectContaining({ runId: id, status: 'error', writerActive: false })]);
  } finally {
    exit(); h.transport = undefined;
    hub.markRunIdle(id); hub.releaseRun(id);
  }
});


it('binds reply ownership before output without treating the consumed UUID list as the reply owner', async () => {
  h.yielded = [];
  h.script = [
    { type: 'system', subtype: 'init' }, { takeInput: true },
    { type: 'stream_event', stamp: 0, event: { type: 'message_start' } },
    { type: 'assistant', stamp: 0, stampAll: [0, 1] },
    { type: 'assistant', stamp: 1, parent_tool_use_id: 'nested-tool' },
    { type: 'result', stamp: 0, stampAll: [0, 1] },
  ];
  const events: Array<Record<string, unknown>> = [];
  const ctx = makeCtx(); ctx.params.runId = 'first';
  ctx.emit = event => { events.push(event); };
  ctx.acceptInput = input => { if (input) input({ text: 'second', inputId: 'second' }); };
  await runSdkLoop(ctx, () => ({}));
  const starts = events.filter(event => event.subtype === 'input_started');
  expect(starts.length).toBeGreaterThan(0);
  expect(starts.every(event => event.inputId === 'first')).toBe(true);
  expect(events.findIndex(event => event.subtype === 'input_started')).toBeLessThan(events.findIndex(event => event.type === 'stream_event'));
});


it('keeps a compaction continuation on the input that owned the interrupted reply', async () => {
  h.yielded = [];
  h.script = [
    { type: 'system', subtype: 'init' }, { takeInput: true },
    { type: 'assistant', stamp: 1 }, { closeOutput: true },
  ];
  const ctx = makeCtx(); ctx.params.runId = 'first';
  const events: Array<Record<string, unknown>> = [];
  ctx.acceptInput = input => { if (input) input({ text: 'second', inputId: 'second' }); };
  ctx.emit = event => {
    events.push(event);
    if (event.type === 'assistant') h.script = [
      { type: 'system', subtype: 'init' },
      { type: 'stream_event', stamp: true, event: { type: 'message_start' } },
      { type: 'result', stamp: true },
    ];
  };
  await runSdkLoop(ctx, () => ({}));
  expect(events.filter(event => event.subtype === 'input_started').map(event => event.inputId)).toEqual(['second', 'second', 'second']);
  expect(events.filter(event => event.subtype === 'input_binding').map(event => event.inputId)).toEqual(['first', 'second']);
  expect(h.yielded).toHaveLength(3);
  expect(h.yielded[2]).toMatchObject({ message: { content: 'continue' } });
});
