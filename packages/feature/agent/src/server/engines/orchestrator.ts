import { updateGlobalState, getSessionTitle } from '../state/globalState';
import { startRun, appendRun, rekeyRun, markRunIdle, isRunActive, setRunAbort } from '../sessionRunHub';
import { resolveCommandPrompt } from '../lib/slashCommands';
import { randomUUID } from 'crypto';
import type { DispatchParams, DispatchOutcome, RunCtx, RunEvent, EngineSpec } from './types';

/**
 * The single run-lifecycle skeleton for ALL engines.
 *
 * Both the /api/chat[/engine] HTTP route and the scheduled-task manager call this directly
 * (no HTTP loopback → no port). It owns the guards (#10 one-active-per-session, #5 runId
 * idempotency), the run-registry lifecycle (startRun → setRunAbort → appendRun → markRunIdle),
 * the 'loading'/'unread' global-state transitions, and the detached fire-and-forget run.
 *
 * Engines provide ONLY `spec.runner.run(ctx)` — the engine-specific loop — plus optional
 * `preflight` and `resolveTitle`. Every event flows to the registry exactly as before, so
 * viewers still stream live via /ws/session-stream and the one-writer guard still holds.
 */
export async function dispatchChat(
  spec: EngineSpec,
  body: DispatchParams,
  request?: Request,
): Promise<DispatchOutcome> {
  const { sessionId, images, cwd, language } = body;

  // #10: one active run per session — a second concurrent write would corrupt the jsonl.
  if (sessionId && isRunActive(sessionId)) {
    return { ok: false, status: 409, error: 'session is already running' };
  }

  // Resolve built-in slash commands (/qa, /fx, …) by language.
  const rawPrompt = body.prompt;
  const prompt =
    typeof rawPrompt === 'string' ? resolveCommandPrompt(rawPrompt, language, request) : rawPrompt;

  // Allow images-only (no text).
  const hasContent = (prompt && typeof prompt === 'string') || (images && images.length > 0);
  if (!hasContent) {
    return { ok: false, status: 400, error: 'Missing prompt or images' };
  }

  // Engine-specific pre-check BEFORE startRun (may resolve model / validate api key).
  if (spec.preflight) {
    const pre = await spec.preflight(body);
    if (!pre.ok) return pre;
  }

  const promptText = typeof prompt === 'string' ? prompt : undefined;

  // #10 ws-converge: the run is fully detached. Start synchronously (client can subscribe by
  // runKey at once), run in the background, return the runKey.
  const abort = new AbortController();
  const runId = (typeof body.runId === 'string' && body.runId) || randomUUID();
  // registry key: real sessionId for resume; provisional runId for new sessions (rekeyed to the
  // engine's real sessionId on reveal). currentKey/actualSessionId are mutated by rekey().
  let currentKey = sessionId || runId;
  let actualSessionId: string | undefined = sessionId;
  let isClosed = false;

  // #5 runId idempotency / #10 one-active: startRun is an atomic test-and-set — it returns false
  // if a turn is already live under currentKey. This is the single authoritative guard (the
  // earlier isRunActive at the top is a fast 409 with a clearer message); because it is atomic
  // it also covers a duplicate submit racing across the preflight await above, where two callers
  // could otherwise both pass a separate check-then-act.
  // runId doubles as the turn's identity marker on the seeded _human event (`_turnId`),
  // letting clients dedup the live user bubble without comparing prompt text.
  if (!startRun(currentKey, cwd || '', promptText, runId)) {
    return { ok: false, status: 409, error: 'run already active' };
  }
  setRunAbort(currentKey, () => {
    isClosed = true;
    abort.abort();
  });
  if (cwd && sessionId) {
    updateGlobalState(cwd, sessionId, 'loading', undefined, promptText).catch(() => {});
  }

  const ctx: RunCtx = {
    prompt: promptText,
    images,
    cwd: cwd || '',
    sessionId,
    params: body,
    signal: abort.signal,
    emit(event: RunEvent) {
      if (isClosed) return;
      appendRun(currentKey, event);
    },
    rekey(realSessionId: string) {
      if (!realSessionId) return;
      // Always record the real session id in the registry (rekeyRun handles oldId===newId, the
      // ollama "runId IS the session id" case) so getRunSessionId resolves and scheduled tasks
      // can rebind instead of degrading to a fresh session every round.
      rekeyRun(currentKey, realSessionId);
      currentKey = realSessionId;
      actualSessionId = realSessionId;
      if (cwd) {
        updateGlobalState(cwd, realSessionId, 'loading', undefined, promptText).catch(() => {});
      }
    },
    currentKey() {
      return currentKey;
    },
  };

  void (async () => {
    try {
      await spec.runner.run(ctx);
    } catch (error) {
      if (abort.signal.aborted) {
        // explicit stop: requestStop already emitted the terminal result + marked idle.
        isClosed = true;
        markRunIdle(currentKey, 'idle');
        return;
      }
      console.error(`[engine:${spec.name}] run error:`, error);
      // Emit the error event BEFORE the terminal mark — appendRun drops events once the run
      // leaves 'running', so the error must reach subscribers first. Prefer the bare message
      // (engines throw Error(msg)) over String(error)'s "Error: " prefix.
      ctx.emit({ type: 'error', error: error instanceof Error ? error.message : String(error) });
      markRunIdle(currentKey, 'error');
      isClosed = true;
      // Best-effort teardown of global state even on failure.
      if (cwd && actualSessionId) {
        const title = await getSessionTitle(cwd, actualSessionId).catch(() => undefined);
        await updateGlobalState(cwd, actualSessionId, 'unread', title).catch(() => {});
      }
      return;
    }
    // Success teardown (shared across all engines).
    if (cwd && actualSessionId) {
      const title = await (spec.runner.resolveTitle
        ? spec.runner.resolveTitle(cwd, actualSessionId).catch(() => undefined)
        : Promise.resolve(undefined));
      await updateGlobalState(cwd, actualSessionId, 'unread', title).catch(() => {});
    }
    isClosed = true;
    markRunIdle(currentKey, 'idle');
  })();

  return { ok: true, runKey: currentKey, sessionId: actualSessionId ?? null };
}
