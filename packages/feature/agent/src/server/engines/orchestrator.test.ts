import { describe, it, expect } from 'vitest';
import { dispatchChat } from './orchestrator';
import { isRunActive, getRunSnapshot, getRunSessionId, requestStop } from '../sessionRunHub';
import type { EngineSpec, InjectedInput, RunCtx, RunEvent } from './types';

// ── Contract suite for the shared run-lifecycle skeleton (orchestrator) ──
// Uses fake engine runners (no real SDK/spawn). cwd is omitted so globalState never touches
// disk (orchestrator gates 'loading'/'unread' on cwd). Each test uses a unique runId so the
// in-memory sessionRunHub registry never collides across tests.

let n = 0;
const freshRunId = () => `test-run-${Date.now()}-${n++}`;

function spec(run: (ctx: RunCtx) => Promise<void>): EngineSpec {
  return { name: 'fake', runner: { run } };
}

/** Runner that blocks until the run is aborted (simulates a long in-flight turn). */
const blockingRun = (ctx: RunCtx) =>
  new Promise<void>((resolve) => {
    if (ctx.signal.aborted) return resolve();
    ctx.signal.addEventListener('abort', () => resolve(), { once: true });
  });

async function waitUntil(pred: () => boolean, ms = 1000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error('waitUntil timeout');
    await new Promise((r) => setTimeout(r, 5));
  }
}

describe('orchestrator dispatch contract', () => {
  it('rejects empty content with 400 and starts no run', async () => {
    const out = await dispatchChat(spec(async () => {}), {});
    expect(out).toEqual({ ok: false, status: 400, error: 'Missing prompt or images' });
  });

  it('success: returns runKey, run is active then idle, events recorded', async () => {
    const runId = freshRunId();
    const events: RunEvent[] = [{ type: 'assistant', text: 'hi' }, { type: 'result' }];
    const out = await dispatchChat(
      spec(async (ctx) => {
        for (const e of events) ctx.emit(e);
      }),
      { prompt: 'hello', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(out.runKey).toBe(runId);
    await waitUntil(() => !isRunActive(out.runKey));
    const snap = getRunSnapshot(out.runKey);
    expect(snap?.status).toBe('idle');
    // synthetic _human user event + the two engine events
    const types = (snap?.events ?? []).map((e) => (e as RunEvent).type);
    expect(types).toContain('assistant');
    expect(types).toContain('result');
  });

  it('#5 idempotency: duplicate active runId → 409', async () => {
    const runId = freshRunId();
    const first = await dispatchChat(spec(blockingRun), { prompt: 'x', runId });
    expect(first.ok).toBe(true);
    const second = await dispatchChat(spec(blockingRun), { prompt: 'x', runId });
    expect(second).toEqual({ ok: false, status: 409, error: 'run already active' });
    if (first.ok) requestStop(first.runKey); // cleanup
  });

  it('#10 guard: duplicate active sessionId → 409', async () => {
    const sessionId = `sess-${Date.now()}-${n++}`;
    const first = await dispatchChat(spec(blockingRun), { prompt: 'x', sessionId });
    expect(first.ok).toBe(true);
    const second = await dispatchChat(spec(blockingRun), { prompt: 'x', sessionId });
    expect(second).toEqual({ ok: false, status: 409, error: 'session is already running' });
    if (first.ok) requestStop(first.runKey);
  });

  it('inject: a mid-run send joins the live run and is seeded as a _human event', async () => {
    const sessionId = `sess-${Date.now()}-${n++}`;
    const got: InjectedInput[] = [];
    const accepting = (ctx: RunCtx) => {
      ctx.acceptInput((input) => { got.push(input); return true; });
      return blockingRun(ctx);
    };
    const first = await dispatchChat(spec(accepting), { prompt: 'x', sessionId });
    expect(first.ok).toBe(true);
    await waitUntil(() => isRunActive(sessionId));
    const runId = freshRunId();
    const second = await dispatchChat(spec(accepting), { prompt: 'also y', sessionId, runId, inject: true });
    expect(second).toEqual({ ok: true, runKey: sessionId, sessionId, injected: true });
    expect(got).toEqual([{ text: 'also y', images: undefined }]);
    const human = (getRunSnapshot(sessionId)?.events ?? []).filter(
      (e) => (e as { _human?: boolean })._human,
    ) as Array<{ _turnId?: string; message: { content: string } }>;
    expect(human.map((e) => e.message.content)).toEqual(['x', 'also y']);
    expect(human[1]._turnId).toBe(runId);
    requestStop(sessionId);
  });

  it('inject: an engine that takes no mid-run input still answers 409', async () => {
    const sessionId = `sess-${Date.now()}-${n++}`;
    const first = await dispatchChat(spec(blockingRun), { prompt: 'x', sessionId });
    expect(first.ok).toBe(true);
    const second = await dispatchChat(spec(blockingRun), { prompt: 'y', sessionId, inject: true });
    expect(second).toEqual({ ok: false, status: 409, error: 'session is already running' });
    requestStop(sessionId);
  });

  it('inject: a run that already closed its input hands the message to a fresh run', async () => {
    const sessionId = `sess-${Date.now()}-${n++}`;
    let finish!: () => void;
    const winding = (ctx: RunCtx) => {
      ctx.acceptInput(() => false); // input closed: still running, but takes nothing more
      return new Promise<void>((resolve) => { finish = resolve; });
    };
    const first = await dispatchChat(spec(winding), { prompt: 'x', sessionId });
    expect(first.ok).toBe(true);
    const prompts: Array<string | undefined> = [];
    const pending = dispatchChat(
      spec(async (ctx) => { prompts.push(ctx.prompt); }),
      { prompt: 'y', sessionId, inject: true },
    );
    await new Promise((r) => setTimeout(r, 20));
    finish();
    const second = await pending;
    expect(second.ok).toBe(true);
    if (second.ok) expect(second.injected).toBeUndefined();
    await waitUntil(() => prompts.length === 1);
    expect(prompts).toEqual(['y']);
  });

  it('failure: runner throws → terminal status error + error event appended', async () => {
    const runId = freshRunId();
    const out = await dispatchChat(
      spec(async () => {
        throw new Error('boom');
      }),
      { prompt: 'x', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => !isRunActive(out.runKey));
    const snap = getRunSnapshot(out.runKey);
    expect(snap?.status).toBe('error');
    expect((snap?.events ?? []).some((e) => (e as RunEvent).type === 'error')).toBe(true);
  });

  it('rekey: new session → getRunSessionId returns the real id after completion', async () => {
    const runId = freshRunId();
    const realId = `real-${Date.now()}-${n++}`;
    const out = await dispatchChat(
      spec(async (ctx) => {
        ctx.rekey(realId);
        ctx.emit({ type: 'result' });
      }),
      { prompt: 'x', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => !isRunActive(realId) && !isRunActive(runId));
    expect(getRunSessionId(realId)).toBe(realId);
  });

  it('rekey same-value (engine uses runId AS its session id, e.g. ollama): getRunSessionId still resolves it', async () => {
    // Regression for the ollama scheduled-task degradation: rekey(currentKey) where the real id
    // equals the runId must still record r.sessionId, else getRunSessionId returns null and the
    // scheduler never rebinds → every round starts fresh.
    const runId = freshRunId();
    const out = await dispatchChat(
      spec(async (ctx) => {
        ctx.rekey(ctx.currentKey()); // realId === runId
        ctx.emit({ type: 'result' });
      }),
      { prompt: 'x', runId },
    );
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    await waitUntil(() => !isRunActive(out.runKey));
    expect(getRunSessionId(out.runKey)).toBe(runId);
  });

  it('stop: requestStop aborts the runner → terminal idle', async () => {
    const runId = freshRunId();
    const out = await dispatchChat(spec(blockingRun), { prompt: 'x', runId });
    expect(out.ok).toBe(true);
    if (!out.ok) return;
    expect(isRunActive(out.runKey)).toBe(true);
    requestStop(out.runKey);
    await waitUntil(() => !isRunActive(out.runKey));
    expect(getRunSnapshot(out.runKey)?.status).toBe('idle');
  });
});
