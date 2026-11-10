import { isRecoverySettlement, type RecoveryDeletion } from '../shared/recoveryCopy';
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

import type { InjectedInput } from './engines/types';

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
  /**
   * Ended by an explicit stop. A stop is the user's own decision, so inputs it
   * leaves undelivered are settled inline but do not turn the run into a failure
   * (and with it a pinned recovery copy in every open tab).
   */
  stopped?: boolean;
  seq: number; // monotonic within the run; snapshot/tail dedupe on it
  events: unknown[]; // current in-flight turn only
  /** Server clock at startRun. The turn's time boundary: every message this run writes to
   *  disk carries a timestamp >= startedAt, every prior turn's is < startedAt. Sent with the
   *  run-snapshot so clients can separate the in-flight turn's disk image from real history
   *  without comparing message text (which breaks on repeated prompts like "继续"). */
  startedAt: number;
  /** The dispatch runId of the in-flight turn. Also stamped on the seeded `_human`
   *  event, but that event only exists when the turn had text or images, so a
   *  viewer needs it on the snapshot too or it cannot scope that turn's
   *  tool-call snapshots (see ChatMessage.runId). */
  runId?: string;
  /** Engine spec name of the turn (`claude`, `codex`, …). Read back by the
   *  delegate endpoint: a delegation with no explicit `engine` inherits the
   *  engine of the session that asked for it, which is only knowable here —
   *  the request carries a run id, not an engine. */
  engine?: string;
  outputTokens?: number;
  updatedAt: number;
  evictTimer?: ReturnType<typeof setTimeout>;
  abort?: () => void; // stop endpoint aborts the detached run via this
  /** Unsupported engines and engines winding down have different dispatch behavior. */
  input: { state: 'unsupported' } | { state: 'accepting'; sink: (input: InjectedInput) => boolean } | { state: 'closed' };
  /**
   * Writer lease: true from startRun until the engine's run() has really returned
   * (releaseRun). Separate from `status` on purpose — Stop flips `status` to idle at once
   * so the UI finalizes, but the engine may still be exiting and writing the transcript.
   * A new turn, or anything that rewrites the transcript, must wait for the lease.
   */
  writer: boolean;
  /** Resolved by releaseRun; waitForWriter races it against a timeout. */
  writerReleased: Promise<void>;
  releaseWriter: () => void;
}

const GRACE_MS = 60_000;

interface RecoveryJournal {
  keys: Set<string>;
  entries: Array<{ order: number; deletion: RecoveryDeletion }>;
  /** Last link or deletion, for least-recently-used eviction. */
  touched?: number;
}

// Bounds for process memory and the per-snapshot payload. Precise evidence is never
// truncated (a cut remap chain would mis-prune copies): a journal over budget is
// compacted into one `clearsBefore` marker that invalidates every older copy instead.
export const MAX_RECOVERY_DELETIONS = 100;
export const MAX_RECOVERY_IDS_PER_SESSION = 2_000;
export const MAX_RECOVERY_IDS_TOTAL = 20_000;
//
// Known limits, accepted because copies are read-only and never reach the
// transcript or the model:
// - Evicting a whole journal (LRU, beyond MAX_RECOVERY_JOURNALS) leaves no marker,
//   so a client that stayed disconnected through it keeps showing turns deleted
//   meanwhile in its copy.
// - `clearsBefore` is wall-clock time compared with run `startedAt`: a run started
//   in the same millisecond as a compaction, or after the clock steps backwards,
//   loses its copy on reconnect. Compaction needs the edit lease, so no run of
//   that session is active at that moment.
export const MAX_RECOVERY_JOURNALS = 500;

const g = globalThis as unknown as {
  __cockpitRunRegistry?: Map<string, RunState>;
  __cockpitRunListeners?: Map<string, Set<RunListener>>;
  __cockpitRunSeqByKey?: Map<string, number>;
  __cockpitTranscriptEdits?: Map<string, Promise<void>>;
  __cockpitFailedRuns?: Set<RunState>;
  __cockpitRecoveryJournal?: { order: number; byKey: Map<string, RecoveryJournal> };
};
const registry: Map<string, RunState> =
  g.__cockpitRunRegistry ?? (g.__cockpitRunRegistry = new Map());
// Failed event buffers survive successor runs for the existing reconnect window.
// They never retain writer ownership and are not a second transcript.
const failedRuns = g.__cockpitFailedRuns ?? (g.__cockpitFailedRuns = new Set<RunState>());
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
// In-flight transcript edits (delete turn): key → resolves when the edit is done. An
// edit is a writer like an engine — it rewrites the whole jsonl — so while one is held,
// no turn may start (startRun refuses, waitForWriter waits).
const edits: Map<string, Promise<void>> =
  g.__cockpitTranscriptEdits ?? (g.__cockpitTranscriptEdits = new Map());

// Mounted copies can outlive every run buffer and a disconnected socket. Retain
// only edit identities/remaps (never transcript contents), bounded by the caps above.
const recoveryJournal = g.__cockpitRecoveryJournal ?? (g.__cockpitRecoveryJournal = { order: 0, byKey: new Map<string, RecoveryJournal>() });
function touchJournal(journal: RecoveryJournal): void {
  journal.touched = ++recoveryJournal.order;
}

/** Drop the least recently used journals (with all their aliases) beyond the cap. */
function evictRecoveryJournals(keep: RecoveryJournal): void {
  const journals = new Set(recoveryJournal.byKey.values());
  if (journals.size <= MAX_RECOVERY_JOURNALS) return;
  const oldest = [...journals].filter(journal => journal !== keep)
    .sort((a, b) => (a.touched ?? 0) - (b.touched ?? 0))
    .slice(0, journals.size - MAX_RECOVERY_JOURNALS);
  for (const journal of oldest) {
    for (const key of journal.keys) if (recoveryJournal.byKey.get(key) === journal) recoveryJournal.byKey.delete(key);
  }
}

function deletionIds(deletion: RecoveryDeletion): number {
  return deletion.sourceIds.length + deletion.taskIds.length + Object.keys(deletion.sourceRemap ?? {}).length;
}

function journalIds(journal: RecoveryJournal): number {
  return journal.entries.reduce((sum, entry) => sum + deletionIds(entry.deletion), 0);
}

/** Replace a journal's evidence by one marker invalidating every copy that exists now. */
function compactJournal(journal: RecoveryJournal): void {
  journal.entries = [{ order: ++recoveryJournal.order, deletion: { sourceIds: [], taskIds: [], clearsBefore: Date.now() } }];
}

function enforceRecoveryBudget(journal: RecoveryJournal): void {
  if (journal.entries.length > MAX_RECOVERY_DELETIONS || journalIds(journal) > MAX_RECOVERY_IDS_PER_SESSION) {
    compactJournal(journal);
  }
  const journals = [...new Set(recoveryJournal.byKey.values())]
    .sort((a, b) => (a.touched ?? 0) - (b.touched ?? 0));
  let total = journals.reduce((sum, current) => sum + journalIds(current), 0);
  for (const current of journals) {
    if (total <= MAX_RECOVERY_IDS_TOTAL) break;
    const ids = journalIds(current);
    if (!ids) continue;
    compactJournal(current);
    total -= ids;
  }
}

function journalFor(key: string): RecoveryJournal {
  let journal = recoveryJournal.byKey.get(key);
  if (!journal) {
    journal = { keys: new Set([key]), entries: [] };
    recoveryJournal.byKey.set(key, journal);
    touchJournal(journal);
    evictRecoveryJournals(journal);
  }
  return journal;
}

/** Preserve alias access and edit order even after both runs have been evicted. */
function linkRecoveryJournals(oldId: string, newId: string): void {
  const old = journalFor(oldId);
  const next = journalFor(newId);
  touchJournal(next);
  if (old === next) return;
  next.entries = [...old.entries, ...next.entries].sort((a, b) => a.order - b.order);
  for (const key of old.keys) { next.keys.add(key); recoveryJournal.byKey.set(key, next); }
  enforceRecoveryBudget(next);
}

export function getRecoveryDeletions(key: string): RecoveryDeletion[] {
  return recoveryJournal.byKey.get(key)?.entries.map(entry => entry.deletion) ?? [];
}

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

function isTransientRunEvent(message: unknown): boolean {
  return (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'usage_update'
  );
}

function getUsageUpdateOutputTokens(message: unknown): number | null {
  if (
    typeof message !== 'object' ||
    message === null ||
    (message as { type?: unknown }).type !== 'usage_update'
  ) {
    return null;
  }
  const outputTokens = (message as { output_tokens?: unknown }).output_tokens;
  return typeof outputTokens === 'number' && Number.isFinite(outputTokens)
    ? Math.max(0, Math.round(outputTokens))
    : null;
}

/**
 * Begin a turn under `key` (a real sessionId for resume, or a provisional runId for a
 * new session). When `promptText` or `images` are given, seeds a synthetic human-user
 * event as the turn's first event so viewers render the new user bubble live (the human
 * prompt is on no engine's stream). Images ride side-band as `_images`, like injectRun's. `_human` lets useLiveStream tell it apart from tool_result `user`
 * events.
 *
 * `runId` is the per-turn unique id (client genRunId() / orchestrator randomUUID). It is
 * stamped on the `_human` event as `_turnId` so clients dedup the live user bubble by
 * identity instead of by text — required for repeated identical prompts ("继续"), where
 * text comparison suppresses the new turn's bubble. `_ts` (= startedAt) rides along for
 * the disk-copy check on the live-event path (no snapshot in hand there).
 */
export function startRun(
  key: string,
  cwd: string,
  promptText?: string,
  runId?: string,
  engine?: string,
  images?: InjectedInput['images'],
): boolean {
  const prev = registry.get(key);
  // Atomic one-active guard (#10/#5): refuse to start if a turn is already live under `key`.
  // The check and the registry.set below run in one synchronous tick (no await between), so two
  // concurrent dispatches for the same session/runId can't both pass — the second gets false.
  // Returning false (vs clobbering) prevents two writers from interleaving the same jsonl.
  //
  // A stopped run is idle but may still hold the writer lease (its engine is exiting);
  // refusing here is what keeps two engines off one session.
  if (prev?.status === 'running' || prev?.writer || edits.has(key)) return false;
  // seq is monotonic across turns (never resets) so a viewer that stays connected over
  // consecutive turns keeps filtering new events by `seq > snapshotSeq`. Fall back to the
  // retained per-key seq when the prior turn has already been evicted from the registry.
  const prevSeq = prev?.seq ?? seqByKey.get(key) ?? 0;
  if (prev) {
    if (prev.evictTimer && !failedRuns.has(prev)) clearTimeout(prev.evictTimer);
    for (const k of prev.keys) registry.delete(k); // drop the prior turn's aliases
  }
  const startedAt = Date.now();
  let releaseWriter!: () => void;
  const writerReleased = new Promise<void>((resolve) => { releaseWriter = resolve; });
  registry.set(key, {
    input: { state: 'unsupported' },
    writer: true,
    writerReleased,
    releaseWriter,
    keys: new Set([key]),
    cwd,
    status: 'running',
    seq: prevSeq,
    events: [],
    startedAt,
    ...(runId ? { runId } : {}),
    ...(engine ? { engine } : {}),
    updatedAt: startedAt,
  });
  if (promptText || images?.length) {
    appendRun(key, {
      type: 'user',
      _human: true,
      ...(runId ? { _turnId: runId } : {}),
      _ts: startedAt,
      message: { role: 'user', content: promptText ?? '' },
      ...(images?.length ? { _images: images } : {}),
    });
  }
  return true;
}

/** Append one event and fan it out to live subscribers across all alias keys. */
export function appendRun(key: string, message: unknown): void {
  const r = registry.get(key);
  if (!r) return;
  // Stop closes model output immediately. Its writer still owns cleanup and may
  // report native input bindings and inputs it could not deliver; retain that
  // evidence before release so recovery still respects later native deletion.
  const frame = message as { type?: string } | null;
  if (r.status !== 'running') {
    if (!r.writer || !isRecoverySettlement(message)) return;
    if (frame?.type === 'error' && !r.stopped) markRunIdle(key, 'error');
  }
  if (typeof message === 'object' && message !== null) {
    const frame = message as { type?: string; subtype?: string; _ts?: number };
    if (frame.type === 'system' && frame.subtype === 'init' && frame._ts === undefined) {
      message = { ...frame, _ts: Date.now() };
    }
  }
  bumpSeq(r);
  const outputTokens = getUsageUpdateOutputTokens(message);
  if (outputTokens !== null) {
    r.outputTokens = Math.max(r.outputTokens ?? 0, outputTokens);
  }
  if (!isTransientRunEvent(message)) {
    r.events.push(message);
  }
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
  linkRecoveryJournals(oldId, newId);
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
    fanout(r, { seq: r.seq, message: { type: 'run-ended', status, writerActive: r.writer, runId: r.runId } });
  }
  scheduleEvict(r);
}

/**
 * Evict the run STATE after the grace window — but never while its writer lease is held,
 * or the lease (the only record that an engine is still writing) would vanish with it;
 * releaseRun re-schedules the eviction instead.
 *
 * Do NOT delete listeners here: a viewer can still be connected past the grace window
 * (its socket is kept alive by heartbeat and only reconnects on close), and the NEXT turn
 * under the same sessionId re-keys a fresh run onto these same listener Sets. Deleting
 * them would silently detach a live viewer from that next turn. Listener lifecycle is
 * owned solely by addRunListener's unsubscribe, which fires on socket close and drops the
 * empty Set.
 */
function scheduleEvict(r: RunState): void {
  if (r.evictTimer) clearTimeout(r.evictTimer);
  r.evictTimer = setTimeout(() => {
    r.evictTimer = undefined;
    if (r.writer) return;
    failedRuns.delete(r);
    for (const k of r.keys) if (registry.get(k) === r) registry.delete(k);
  }, GRACE_MS);
}

/**
 * The engine's run() has returned: its process is gone and it writes nothing more for
 * this session. Releases the writer lease; idempotent.
 */
export function releaseRun(key: string): void {
  const r = registry.get(key);
  if (!r || !r.writer) return;
  if (r.status === 'error') failedRuns.add(r);
  r.writer = false;
  r.releaseWriter();
  // Stop can announce the terminal state before the engine finishes flushing.
  // This second phase is the point at which disk reads may replace live content.
  if (r.status !== 'running') {
    bumpSeq(r);
    fanout(r, { seq: r.seq, message: { type: 'run-settled', status: r.status, runId: r.runId } });
  }
  if (r.status !== 'running') scheduleEvict(r);
}

/**
 * Wait until nothing holds the writer lease for `key` — neither an engine (a stopped run
 * may still be exiting) nor a transcript edit. Resolves true once free, false if still
 * held after `timeoutMs`.
 */
export async function waitForWriter(key: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const r = registry.get(key);
    const held = r?.writer ? r.writerReleased : edits.get(key);
    if (!held) return true;
    const left = deadline - Date.now();
    if (left <= 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<false>((resolve) => { timer = setTimeout(() => resolve(false), left); });
    const freed = await Promise.race([held.then(() => true as const), timedOut]);
    clearTimeout(timer);
    if (!freed) return false;
  }
}

/**
 * True while a turn is streaming, its engine still holds the writer lease, or the
 * transcript is being edited.
 */
export function isSessionBusy(key: string): boolean {
  const r = registry.get(key);
  return edits.has(key) || (!!r && (r.status === 'running' || r.writer));
}

/** A cheap read marker: unlike a replay snapshot, this never copies event buffers. */
export function historyReadMarker(key: string): string {
  const run = registry.get(key);
  return JSON.stringify([run?.runId, run?.startedAt, run?.seq, run?.writer, edits.has(key)]);
}

/**
 * Take the writer lease for an edit of `key`'s transcript. Returns null if the session is
 * busy; otherwise a release function, and until it is called no turn can start on `key`.
 * Check and take happen in one synchronous tick, so an edit and a turn cannot both pass.
 */
export function beginTranscriptEdit(key: string): (() => void) | null {
  if (isSessionBusy(key)) return null;
  let done!: () => void;
  const finished = new Promise<void>((resolve) => { done = resolve; });
  edits.set(key, finished);
  return () => {
    if (edits.get(key) === finished) edits.delete(key);
    done();
  };
}

/** Snapshot of the current in-flight turn for a freshly connecting client. */
export function getRunSnapshot(
  key: string
): { status: RunStatus; seq: number; events: unknown[]; startedAt: number; runId?: string; outputTokens?: number; writerActive: boolean; recoveryDeletions?: RecoveryDeletion[] } | null {
  const r = registry.get(key);
  if (!r) return null;
  return { status: r.status, seq: r.seq, events: r.events.slice(), startedAt: r.startedAt, runId: r.runId, outputTokens: r.outputTokens, writerActive: r.writer, recoveryDeletions: getRecoveryDeletions(key) };
}

/** Replay older failures before the current snapshot without transferring writer ownership. */
export function getRunRecoveries(key: string) {
  return [...failedRuns].filter((run) => run.keys.has(key) && run !== registry.get(key))
    .map((run) => ({ type: 'run-snapshot' as const, recovery: true, status: 'error' as const,
      runId: run.runId, startedAt: run.startedAt, events: run.events.slice(), writerActive: false,
      recoveryDeletions: getRecoveryDeletions(key) }));
}

/** Successful deletion invalidates copies independently of run-buffer retention. */
export function deleteRunRecoveryTurns(key: string, deletion: RecoveryDeletion): void {
  const journal = journalFor(key);
  journal.entries.push({ order: ++recoveryJournal.order, deletion: {
    sourceIds: [...deletion.sourceIds], taskIds: [...deletion.taskIds],
    ...(deletion.sourceRemap ? { sourceRemap: { ...deletion.sourceRemap } } : {}),
  } });
  touchJournal(journal);
  enforceRecoveryBudget(journal);
  // Alias subscribers can outlive their run too. Use one sequence greater than
  // every alias watermark, including when the current run has already expired.
  let seq = 0;
  for (const alias of journal.keys) seq = Math.max(seq, seqByKey.get(alias) ?? 0, registry.get(alias)?.seq ?? 0);
  seq += 1;
  for (const alias of journal.keys) {
    seqByKey.set(alias, seq);
    const run = registry.get(alias);
    if (run) run.seq = seq;
  }
  const event = { seq, message: { type: 'recovery-deleted', deletion } };
  for (const alias of journal.keys) {
    for (const listener of listeners.get(alias) ?? []) { try { listener(event); } catch { /* Match live fanout isolation. */ } }
  }
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

/**
 * cwd + real sessionId of a run, by any of its keys. Used to resolve the session a
 * skill's curl runs in (COCKPIT_RUN_ID) — that run is necessarily live while its own
 * tool call executes, so the grace window never gets in the way.
 */
export function getRunInfo(
  key: string,
): { cwd: string; sessionId: string | null; engine: string | null } | null {
  const r = registry.get(key);
  if (!r) return null;
  // `engine` is deliberately independent of `sessionId`: a session's FIRST turn
  // has no session id until the engine reveals one, and a caller that gates on
  // the id would read no engine exactly when a brand-new session delegates.
  return { cwd: r.cwd, sessionId: r.sessionId ?? null, engine: r.engine ?? null };
}

/** Register a sink, or seal input so dispatch can wait for the writer and start another run. */
export function setRunInjector(key: string, injector: ((input: InjectedInput) => boolean) | null): void {
  const r = registry.get(key);
  if (!r) return;
  r.input = injector ? { state: 'accepting', sink: injector } : { state: 'closed' };
}

/**
 * Hand a user message to the live run under `key`.
 *  - 'ok': the engine took it; a `_human` event (stamped `_turnId` = runId) is appended so
 *    every subscriber renders the bubble, exactly like the one startRun seeds.
 *  - 'unsupported': the run's engine takes no input mid-run.
 *  - 'closed': the engine already closed its input — the run is winding down, and the
 *    message belongs to the next run.
 *  - 'idle': nothing is running under `key`.
 */
export function injectRun(
  key: string,
  input: InjectedInput,
  runId: string,
): 'ok' | 'unsupported' | 'closed' | 'idle' {
  const r = registry.get(key);
  if (!r || r.status !== 'running') return 'idle';
  if (r.input.state === 'unsupported') return 'unsupported';
  if (r.input.state === 'closed' || !r.input.sink({ ...input, inputId: runId })) return 'closed';
  appendRun(key, {
    type: 'user',
    _human: true,
    _turnId: runId,
    _ts: Date.now(),
    message: { role: 'user', content: input.text ?? '' },
    // Side-band rather than content blocks, so every reader that takes `content` as the
    // prompt text keeps working; the bubble shows them next to the text.
    ...(input.images?.length ? { _images: input.images } : {}),
  });
  return 'ok';
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
  r.stopped = true;
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
