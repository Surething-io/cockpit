/**
 * sessionRunHub — per-session in-flight run registry + live subscription (#10).
 *
 * The run is detached from any HTTP request: each /api/chat* route starts a run here,
 * runs the engine loop in the background, and writes every event via appendRun. Every
 * client — the originator AND other tabs/devices — consumes the run over
 * /ws/session-stream (snapshot + live tail). No SSE, so a refresh/disconnect can't kill
 * a run.
 *
 * Alias keys: a new session has no engine sessionId yet, so the client generates a
 * provisional `runId` and the route starts the run under it. When the engine reveals its
 * real sessionId (system.init / thread.started / kimi's fs-detect), rekeyRun ADDS the
 * sessionId as an alias WITHOUT dropping the runId — both keys resolve to the same run
 * for the rest of its life. This closes the race where the detached loop rekeys before
 * the originator's ws (subscribed by runId) connects, and lets viewers subscribe by the
 * stable sessionId. appendRun fans out across all of a run's keys.
 *
 * Pinned to globalThis: cockpit serves /api/chat (writer) and the WS server (reader)
 * in the same Node realm (server.mjs), but a second module realm must not create a
 * parallel registry — same rationale as `globalStateClients` in src/lib/wsServer.ts.
 */

export type RunStatus = 'running' | 'idle' | 'error';
export interface RunEvent {
  seq: number;
  message: unknown; // raw SDK message (carries top-level `.uuid`)
}
type RunListener = (ev: RunEvent) => void;

interface RunState {
  keys: Set<string>; // all aliases for this run (provisional runId + real sessionId)
  cwd: string;
  /** The engine's real sessionId once revealed (via rekeyRun). Lets a detached
   *  caller that only kept the provisional runId recover the new session id after
   *  the run — used by scheduled tasks to persist a freshly-created session. */
  sessionId?: string;
  status: RunStatus;
  seq: number; // monotonic within the run; snapshot/tail dedupe on it
  events: unknown[]; // current in-flight turn only
  /** Server clock at startRun. The turn's time boundary: every message this run writes to
   *  disk carries a timestamp >= startedAt, every prior turn's is < startedAt. Sent with the
   *  run-snapshot so clients can separate the in-flight turn's disk image from real history
   *  without comparing message text (which breaks on repeated prompts like "继续"). */
  startedAt: number;
  updatedAt: number;
  evictTimer?: ReturnType<typeof setTimeout>;
  abort?: () => void; // stop endpoint aborts the detached run via this
}

const GRACE_MS = 60_000;

const g = globalThis as unknown as {
  __cockpitRunRegistry?: Map<string, RunState>;
  __cockpitRunListeners?: Map<string, Set<RunListener>>;
  __cockpitRunSeqByKey?: Map<string, number>;
};
const registry: Map<string, RunState> =
  g.__cockpitRunRegistry ?? (g.__cockpitRunRegistry = new Map());
const listeners: Map<string, Set<RunListener>> =
  g.__cockpitRunListeners ?? (g.__cockpitRunListeners = new Map());
// Last seq seen per key — SURVIVES eviction (registry entries are dropped after the grace
// window, this is not). A new turn under an evicted key resumes seq from here instead of
// resetting to 0. Without this, a long-lived viewer (connected mid-prior-turn, so its
// snapshotSeq is a high value) would have the next turn's reset-to-low seq filtered out by
// `seq > snapshotSeq` and silently miss the whole turn. Pairs with keeping listeners alive
// across eviction — both are required for a viewer to span the grace window correctly.
const seqByKey: Map<string, number> =
  g.__cockpitRunSeqByKey ?? (g.__cockpitRunSeqByKey = new Map());

/** Advance a run's seq and remember it under every alias so it survives eviction. */
function bumpSeq(state: RunState): number {
  state.seq += 1;
  for (const k of state.keys) seqByKey.set(k, state.seq);
  return state.seq;
}

/** Fan an event out to the union of listeners across all of a run's alias keys. */
function fanout(state: RunState, ev: RunEvent): void {
  for (const k of state.keys) {
    const ls = listeners.get(k);
    if (ls) for (const cb of ls) { try { cb(ev); } catch { /* ignore */ } }
  }
}

/**
 * Begin a turn under `key` (a real sessionId for resume, or a provisional runId for a
 * new session). When `promptText` is given, seeds a synthetic human-user event as the
 * turn's first event so viewers render the new user bubble live (the human prompt is on
 * no engine's stream). `_human` lets useLiveStream tell it apart from tool_result `user`
 * events.
 *
 * `runId` is the per-turn unique id (client genRunId() / orchestrator randomUUID). It is
 * stamped on the `_human` event as `_turnId` so clients dedup the live user bubble by
 * identity instead of by text — required for repeated identical prompts ("继续"), where
 * text comparison suppresses the new turn's bubble. `_ts` (= startedAt) rides along for
 * the disk-copy check on the live-event path (no snapshot in hand there).
 */
export function startRun(key: string, cwd: string, promptText?: string, runId?: string): boolean {
  const prev = registry.get(key);
  // Atomic one-active guard (#10/#5): refuse to start if a turn is already live under `key`.
  // The check and the registry.set below run in one synchronous tick (no await between), so two
  // concurrent dispatches for the same session/runId can't both pass — the second gets false.
  // Returning false (vs clobbering) prevents two writers from interleaving the same jsonl.
  if (prev?.status === 'running') return false;
  // seq is monotonic across turns (never resets) so a viewer that stays connected over
  // consecutive turns keeps filtering new events by `seq > snapshotSeq`. Fall back to the
  // retained per-key seq when the prior turn has already been evicted from the registry.
  const prevSeq = prev?.seq ?? seqByKey.get(key) ?? 0;
  if (prev) {
    if (prev.evictTimer) clearTimeout(prev.evictTimer);
    for (const k of prev.keys) registry.delete(k); // drop the prior turn's aliases
  }
  const startedAt = Date.now();
  registry.set(key, {
    keys: new Set([key]),
    cwd,
    status: 'running',
    seq: prevSeq,
    events: [],
    startedAt,
    updatedAt: startedAt,
  });
  if (promptText) {
    appendRun(key, {
      type: 'user',
      _human: true,
      ...(runId ? { _turnId: runId } : {}),
      _ts: startedAt,
      message: { role: 'user', content: promptText },
    });
  }
  return true;
}

/** Append one event and fan it out to live subscribers across all alias keys. */
export function appendRun(key: string, message: unknown): void {
  const r = registry.get(key);
  if (!r) return;
  // Drop events that arrive after the run reached a terminal state: once run-ended fired,
  // a viewer has finalized its bubble, so a late engine event (cooperative-abort flush,
  // a straggler line after stop) must not fan out and mutate it. The run stays in the
  // registry during the grace window, so the existence check alone is not enough.
  if (r.status !== 'running') return;
  bumpSeq(r);
  r.events.push(message);
  r.updatedAt = Date.now();
  fanout(r, { seq: r.seq, message });
}

/**
 * The engine revealed its real sessionId mid-run: ADD it as an alias so both the
 * provisional runId and the real sessionId resolve to the same run. Listeners on either
 * key already receive events (fanout iterates all keys), so nothing to migrate.
 */
export function rekeyRun(oldId: string, newId: string): void {
  const r = registry.get(oldId);
  if (!r) return;
  // Always record the real session id for post-run recovery — even when oldId === newId
  // (ollama uses the runId AS its session id, so getRunSessionId must still resolve it;
  // otherwise scheduled ollama tasks never rebind and degrade to a fresh session each round).
  r.sessionId = newId;
  if (oldId !== newId) {
    r.keys.add(newId);
    registry.set(newId, r);
  }
}

/** Turn finished/errored: keep state for a grace window, then evict all alias keys. */
export function markRunIdle(key: string, status: RunStatus = 'idle'): void {
  const r = registry.get(key);
  if (!r) return;
  const wasRunning = r.status === 'running';
  // Terminal precedence. A run reaches a terminal state exactly once; later callers must
  // not corrupt it. The trigger this guards: an engine's error path marks 'error', then its
  // process-close handler unconditionally marks 'idle' — without this, the second call would
  // clobber 'error' back to 'idle' and a failed turn would read as success (scheduled tasks
  // poll getRunSnapshot().status). Rules: running → idle|error; idle → error allowed (a late
  // error upgrades); error is sticky (never downgraded to idle). Only the running→terminal
  // transition fires run-ended (a second call must not re-fire it).
  if (!wasRunning) {
    if (r.status === 'idle' && status === 'error') r.status = 'error';
    return;
  }
  r.status = status;
  r.updatedAt = Date.now();
  // Notify connected subscribers the run truly ended. Engines may emit several
  // intermediate `result` events (codex = one per turn); this fires EXACTLY once at the
  // real end, so the originator's loading state and viewers stop on it — not on a result.
  // Bumped seq so it passes the snapshot dedupe filter; NOT stored in events (a reconnect
  // sees status=idle instead, so it must not be replayed).
  {
    bumpSeq(r);
    fanout(r, { seq: r.seq, message: { type: 'run-ended', status } });
  }
  if (r.evictTimer) clearTimeout(r.evictTimer);
  r.evictTimer = setTimeout(() => {
    // Evict only the run STATE. Do NOT delete listeners here: a viewer can still be
    // connected past the grace window (its socket is kept alive by heartbeat and only
    // reconnects on close), and the NEXT turn under the same sessionId re-keys a fresh run
    // onto these same listener Sets. Deleting them would silently detach a live viewer from
    // that next turn. Listener lifecycle is owned solely by addRunListener's unsubscribe,
    // which fires on socket close and drops the empty Set.
    for (const k of r.keys) registry.delete(k);
  }, GRACE_MS);
}

/** Snapshot of the current in-flight turn for a freshly connecting client. */
export function getRunSnapshot(
  key: string
): { status: RunStatus; seq: number; events: unknown[]; startedAt: number } | null {
  const r = registry.get(key);
  if (!r) return null;
  return { status: r.status, seq: r.seq, events: r.events.slice(), startedAt: r.startedAt };
}

/** True while a turn is actively running (used by the 409 concurrent-run guard). */
export function isRunActive(key: string): boolean {
  return registry.get(key)?.status === 'running';
}

/**
 * The engine's real sessionId for a run, once revealed via rekeyRun. Returns null
 * if the run was a plain resume (no rekey) or is no longer in the registry. Read it
 * within the post-run grace window (same reliability as getRunSnapshot).
 */
export function getRunSessionId(key: string): string | null {
  return registry.get(key)?.sessionId ?? null;
}

/** Register the detached run's abort fn so the stop endpoint can cancel it. */
export function setRunAbort(key: string, abort: () => void): void {
  const r = registry.get(key);
  if (r) r.abort = abort;
}

/**
 * Explicit stop (from POST /api/chat/stop, by any tab): abort the detached run, then emit
 * a terminal `result` event so EVERY subscriber (the originator AND viewers) finalizes its
 * bubble — the engine's abort path is otherwise silent to the stream. Then mark idle.
 */
export function requestStop(key: string): boolean {
  const r = registry.get(key);
  if (!r) return false;
  try { r.abort?.(); } catch { /* ignore */ }
  // No `usage` field: the result handler only updates token counts when usage is present,
  // so omitting it preserves the turn's real token counter on stop.
  appendRun(key, { type: 'result', subtype: 'stopped' });
  markRunIdle(key, 'idle');
  return true;
}

/** Subscribe to live events for `key`; returns an unsubscribe fn. */
export function addRunListener(key: string, cb: RunListener): () => void {
  let s = listeners.get(key);
  if (!s) { s = new Set(); listeners.set(key, s); }
  s.add(cb);
  return () => {
    const set = listeners.get(key);
    if (set && set.delete(cb) && set.size === 0) listeners.delete(key);
  };
}
