import { removeRecoveryTurns, type RecoveryDeletion } from '../shared/recoveryCopy';
import type { HistoryCoordinates, HistoryReference } from '../shared/historyReference';
import type { SetStateAction } from 'react';
import type { ChatMessage } from './types';
import { splitTurns } from '../shared/chatTurns';
import { reuseMessages } from './mergeIncrementalMessages';
import { applyStreamEvent, isToolUpdateEvent, type StreamEvent } from './applyStreamEvent';

export interface HistoryPage extends HistoryCoordinates {
  messages: ChatMessage[];
  totalTurns?: number;
  startTurnIndex?: number;
  hasMore?: boolean;
  /** False while a writer may expose an incomplete logical source. */
  stable?: boolean;
}
export interface LiveHistoryRun { id: string; startedAt: number; recovery?: boolean }
interface DiskTurn { index: number; messages: ChatMessage[] }
export interface HistoryRun extends LiveHistoryRun {
  phase: 'pending' | 'active' | 'draining' | 'released';
  /** A terminal error does not release the writer; retain its outcome while draining. */
  terminalError?: boolean;
  messages: ChatMessage[];
  start: number;
  /** A native input, not an absolute coordinate, anchors a previously matched run. */
  anchor?: { source: HistoryReference; liveId: string };
}
export interface HistoryFailure extends LiveHistoryRun {
  messages: ChatMessage[];
}
export interface ChatHistoryState {
  messages: ChatMessage[];
  diskTurns: DiskTurn[];
  runs: HistoryRun[];
  failures: HistoryFailure[];
  /**
   * Recovery copies the user closed. Kept apart from `failures` because a run's
   * late events re-remember it (see `rememberFailure` callers), which would
   * otherwise bring a closed copy straight back.
   */
  dismissedFailures: string[];
  sessionId: string | null;
  startTurnIndex?: number;
  totalTurns: number;
  hasMore: boolean;
  /** The server cursor stays paired with its proof even when live content extends the view. */
  diskCursor?: { index: number; proof?: string };
  needsStableRead: boolean;
  /** Idle can be observed before this tab has ever rendered the corresponding run. */
  writerIdle: boolean;
  /** A fresh idle observation can retry an unfinished final read without polling. */
  writerIdleRevision: number;
}
export const emptyChatHistory: ChatHistoryState = {
  messages: [], diskTurns: [], runs: [], failures: [], dismissedFailures: [], sessionId: null, totalTurns: 0, hasMore: false, needsStableRead: false, writerIdle: false, writerIdleRevision: 0,
};
export type HistoryMessageUpdate = SetStateAction<ChatMessage[]>
  | { event: StreamEvent; engine?: string; assistantId: string };
export type RunMessageUpdate = (runId: string, update: HistoryMessageUpdate) => void;
export type ChatHistoryAction =
  | { type: 'messages'; update: SetStateAction<ChatMessage[]> }
  | { type: 'run-messages'; runId: string; update: HistoryMessageUpdate }
  | { type: 'sender-start'; run: LiveHistoryRun }
  | { type: 'replay-start'; run: LiveHistoryRun }
  | { type: 'run-accepted'; run: LiveHistoryRun }
  | { type: 'run-end'; runId: string; writerActive: boolean; failed?: boolean }
  | { type: 'send-failed'; runId: string }
  | { type: 'input-rejected'; sessionId: string; copy: HistoryFailure }
  | { type: 'validated'; sessionId: string; stable: boolean }
  | { type: 'recovery-deleted'; deletion: RecoveryDeletion }
  | { type: 'recovery-dismissed'; id: string }
  | { type: 'writer-idle'; sessionId: string }
  | { type: 'page'; sessionId: string; page: HistoryPage;
      mode: 'replace' | 'incremental' | 'prepend' | 'jump';
      endTurnIndex?: number; reconciles?: string[]; fromCache?: boolean; toolUpdates?: Array<{ event: StreamEvent; engine?: string; assistantId: string }> };

function turnTime(messages: ChatMessage[]): number {
  const first = messages[0];
  const timestamp = first?.turnStartedAt ?? messages.find((message) => message.role === 'user')?.timestamp ?? first?.timestamp;
  return timestamp ? Date.parse(timestamp) : NaN;
}

function referencesInput(source: HistoryReference, message: ChatMessage): boolean {
  return source.sourceId ? (message.sourceId ?? message.id) === source.sourceId
    : message.id === source.id && (!source.prefix || message.sourceRef?.prefix === source.prefix);
}

/** Re-resolve native identity against every window; input admission clocks are not offsets. */
export function locateHistoryRun(run: HistoryRun, disk: DiskTurn[]): number | undefined {
  if (run.phase === 'pending') return undefined;
  const turns = splitTurns(run.messages);
  for (const cell of disk) {
    const offset = turns.findIndex((turn) => turn.some((row) => cell.messages.some((message) =>
      row.id === message.id || (!!row.sourceId && row.sourceId === (message.sourceId ?? message.id))
      || (!!row.sourceTaskId && row.sourceTaskId === message.sourceTaskId))));
    if (offset >= 0) return Math.max(0, cell.index - offset);
  }
  if (run.anchor) {
    const anchor = run.anchor;
    const offset = turns.findIndex((turn) => turn.some((row) => row.id === anchor.liveId
      && (!row.sourceId || row.sourceId === (anchor.source.sourceId ?? anchor.source.id))));
    const cell = disk.find((cell) => cell.messages.some((row) => referencesInput(anchor.source, row)));
    if (cell && offset >= 0) return Math.max(0, cell.index - offset);
  }
  for (const cell of disk) {
    const offset = turns.findIndex((turn) => turn.some((row) => row.toolCalls?.some((tool) =>
      cell.messages.some((message) => message.toolCalls?.some((other) => other.id === tool.id)))));
    if (offset >= 0) return Math.max(0, cell.index - offset);
  }
  // A known native identity cannot be replaced by weaker timing/text evidence.
  if (run.messages.some((row) => row.sourceId || row.sourceTaskId)) return undefined;
  // Compatibility for snapshots without input bindings. The run clock partitions
  // old history from this writer's first turn, but cannot identify queued rounds.
  if (!Number.isFinite(turnTime(turns[0] ?? []))) return undefined;
  const first = disk.find((cell) => turnTime(cell.messages) >= run.startedAt);
  if (!first) return undefined;
  const preceding = disk.find((cell) => cell.index === first.index - 1);
  if (first.index === 0 || (preceding && turnTime(preceding.messages) < run.startedAt)) return first.index;
  // A partial window may omit the run's beginning. Only an unambiguous input
  // match can establish its offset; repeated text is not an input identity.
  const candidates = new Set<number>();
  for (const cell of disk.filter((cell) => turnTime(cell.messages) >= run.startedAt)) {
    const inputs = cell.messages.filter((row) => row.role === 'user');
    turns.forEach((turn, offset) => {
      const live = turn.filter((row) => row.role === 'user');
      if (inputs.length && live.length && live[0].content === inputs[0].content
        && JSON.stringify(live[0].images) === JSON.stringify(inputs[0].images)) candidates.add(cell.index - offset);
    });
  }
  return candidates.size === 1 ? Math.max(0, [...candidates][0]) : undefined;
}

/** Keep only the source reference and live input needed to re-resolve a location. */
function runAnchor(run: HistoryRun, disk: DiskTurn[], start: number): HistoryRun['anchor'] {
  for (const [offset, turn] of splitTurns(run.messages).entries()) {
    const live = turn.find((row) => row.role === 'user');
    const source = disk.find((cell) => cell.index === start + offset)?.messages.find((row) => row.role === 'user');
    if (live && source) return { liveId: live.id, source: source.sourceRef ?? { id: source.id, sourceId: source.sourceId, prefix: '' } };
  }
  return run.anchor;
}

/** Keep the complete observed copy; existence of history is not output coverage. */
function recoveryCopy(run: HistoryFailure): HistoryFailure {
  return { id: run.id, startedAt: run.startedAt, messages: run.messages.map((row) => ({
    ...row, isStreaming: false,
    toolCalls: row.toolCalls?.map((tool) => ({ ...tool, isLoading: false })),
  })) };
}

function rememberFailure(failures: HistoryFailure[], run: HistoryFailure): HistoryFailure[] {
  return [...failures.filter((failure) => failure.id !== run.id), ...(run.messages.length ? [recoveryCopy(run)] : [])];
}

function occupiesHistory(run: HistoryRun): boolean {
  return !(run.terminalError && run.phase === 'released');
}

/** The disk window and each run have one owner; rendered messages are derived. */
function composeWindow(state: ChatHistoryState, refreshTail = false): ChatHistoryState {
  const cells = new Map(state.diskTurns.map((turn) => [turn.index, turn.messages]));
  let tail = state.totalTurns;
  const runs = state.runs.map((run, position) => {
    const match = locateHistoryRun(run, state.diskTurns);
    // A successor may have been allocated while the failed writer still owned
    // a live tail. Releasing that copy must remove its provisional gap too.
    const collapsedFailure = state.runs.slice(0, position).some(prior => !occupiesHistory(prior));
    const start = match ?? (refreshTail || run.anchor || (collapsedFailure && run.start > tail) ? tail : run.start);
    const next = { ...run, start, anchor: match === undefined ? run.anchor : runAnchor(run, state.diskTurns, start) };
    if (occupiesHistory(run)) tail = Math.max(tail, start + splitTurns(run.messages).length);
    return next;
  });
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run.messages.length || !occupiesHistory(run)) continue;
    const nextStart = runs.slice(i + 1).find((next) => occupiesHistory(next))?.start ?? Infinity;
    // An active run owns its tail. Released runs remain visible only until the
    // read that explicitly covers them is applied, independently of newer runs.
    for (const index of cells.keys()) if (index >= run.start && index < nextStart) cells.delete(index);
    splitTurns(run.messages).forEach((messages, offset) => {
      if (run.start + offset < nextStart) cells.set(run.start + offset, messages);
    });
  }
  const indexes = [...cells.keys()].sort((a, b) => a - b);
  if (!indexes.length) return { ...state, runs, messages: reuseMessages(state.messages, []), startTurnIndex: 0, hasMore: false };
  let first = indexes.length - 1;
  while (first > 0 && indexes[first - 1] === indexes[first] - 1) first--;
  const startTurnIndex = indexes[first];
  return { ...state, runs, startTurnIndex, hasMore: startTurnIndex > 0,
    messages: reuseMessages(state.messages, indexes.slice(first).flatMap((index) => cells.get(index)!)) };
}

export function chatHistoryReducer(state: ChatHistoryState, action: ChatHistoryAction): ChatHistoryState {
  if (action.type === 'recovery-dismissed') {
    return { ...state, dismissedFailures: [...state.dismissedFailures, action.id],
      failures: state.failures.filter((copy) => copy.id !== action.id) };
  }
  const next = reduceChatHistory(state, action);
  if (next === state || !next.dismissedFailures.length) return next;
  const failures = next.failures.filter((copy) => !next.dismissedFailures.includes(copy.id));
  return failures.length === next.failures.length ? next : { ...next, failures };
}

function reduceChatHistory(state: ChatHistoryState, action: Exclude<ChatHistoryAction, { type: 'recovery-dismissed' }>): ChatHistoryState {
  if (action.type === 'sender-start' || action.type === 'replay-start' || action.type === 'run-accepted') {
    const accepted = action.type !== 'sender-start' && !action.run.recovery;
    const existing = state.runs.find((run) => run.id === action.run.id);
    const position = existing ? state.runs.indexOf(existing) : state.runs.length;
    // A server admission/snapshot proves the preceding writer released its lease.
    // An optimistic send alone does not provide that evidence.
    let runs = state.runs.map((run, index) => accepted && index < position && run.phase !== 'pending'
      ? { ...run, phase: 'released' as const } : run);
    let failures = state.failures;
    for (const prior of runs) {
      if (prior.terminalError && prior.phase === 'released' && state.runs.find((old) => old.id === prior.id)?.phase !== 'released') {
        failures = rememberFailure(failures, prior);
      }
    }
    const run: HistoryRun = {
      ...action.run, phase: action.run.recovery ? 'released' : existing && (existing.phase === 'draining' || existing.phase === 'released') ? existing.phase : accepted ? 'active' : 'pending',
      terminalError: action.run.recovery || existing?.terminalError,
      messages: action.type === 'replay-start' ? [] : existing?.messages ?? [],
      start: existing?.start ?? Math.max(state.totalTurns, ...runs.filter(occupiesHistory).map((r) => r.start + splitTurns(r.messages).length)),
      anchor: existing?.anchor,
    };
    runs = existing ? runs.map((r) => r.id === run.id ? run : r) : [...runs, run];
    return composeWindow({ ...state, runs, failures, writerIdle: false });
  }
  if (action.type === 'input-rejected') {
    if (state.sessionId !== null && state.sessionId !== action.sessionId) return state;
    return { ...state, failures: rememberFailure(state.failures, action.copy) };
  }
  if (action.type === 'validated') {
    if (state.sessionId !== null && state.sessionId !== action.sessionId) return state;
    return { ...state, sessionId: action.sessionId, needsStableRead: !action.stable };
  }
  if (action.type === 'writer-idle') {
    if (state.sessionId !== null && state.sessionId !== action.sessionId) return state;
    return { ...state, sessionId: action.sessionId, writerIdle: true, writerIdleRevision: state.writerIdleRevision + 1 };
  }
  if (action.type === 'run-end') {
    const observed = state.runs.some((run) => run.id === action.runId);
    const runs = state.runs.map((run): HistoryRun => run.id === action.runId
      ? { ...run, ...(action.failed ? { terminalError: true } : {}),
        phase: action.writerActive && run.phase !== 'released' ? 'draining' : 'released' } : run);
    const failedRun = runs.find((run) => run.id === action.runId && run.terminalError && run.phase === 'released');
    const failures = failedRun ? rememberFailure(state.failures, failedRun) : state.failures;
    const busy = runs.some((run) => run.phase === 'pending' || run.phase === 'active' || run.phase === 'draining');
    // For an observed run, its phase already accounts for late terminal events.
    // An unobserved writer still needs an explicit release observation.
    return composeWindow({ ...state, runs, failures, writerIdle: !busy && (observed || state.writerIdle || !action.writerActive) });
  }
  if (action.type === 'send-failed') {
    const run = state.runs.find((run) => run.id === action.runId);
    if (!run) return state;
    return composeWindow({ ...state, runs: state.runs.filter((current) => current !== run),
      failures: rememberFailure(state.failures, run),
    });
  }
  if (action.type === 'recovery-deleted') {
    const { clearsBefore } = action.deletion;
    const invalid = (copy: LiveHistoryRun) => clearsBefore !== undefined && copy.startedAt <= clearsBefore;
    return composeWindow({ ...state,
      failures: state.failures.filter((copy) => !invalid(copy))
        .map((copy) => ({ ...copy, messages: removeRecoveryTurns(copy.messages, action.deletion) }))
        .filter((copy) => copy.messages.length),
      runs: state.runs.map((run) => run.terminalError
        ? { ...run, messages: invalid(run) ? [] : removeRecoveryTurns(run.messages, action.deletion) } : run),
    });
  }
  if (action.type === 'run-messages') {
    const owner = state.runs.find((run) => run.id === action.runId);
    if (!owner) return state;
    const change = action.update;
    const stream = typeof change === 'object' && !Array.isArray(change) ? change : undefined;
    const update = (rows: ChatMessage[]) => typeof change === 'function' ? change(rows)
      : Array.isArray(change) ? change : applyStreamEvent(rows, change.event, change);
    // Run ownership governs new output; tool identity governs updates to existing
    // cards. Archived failure replays remain private recovery copies.
    const acrossRuns = !!stream && !owner.recovery && isToolUpdateEvent(stream.event);
    const runs = state.runs.map((run) => run === owner || (acrossRuns && !run.terminalError)
      ? { ...run, messages: update(run.messages) } : run);
    const diskTurns = acrossRuns ? state.diskTurns.map((cell) => ({ ...cell, messages: update(cell.messages) })) : state.diskTurns;
    const failed = runs.find((run) => run.id === action.runId && run.terminalError && run.phase === 'released');
    return composeWindow({ ...state, diskTurns, runs, failures: failed ? rememberFailure(state.failures, failed) : state.failures });
  }
  if (action.type === 'messages') {
    // Local edits update existing records; stream ownership is handled above.
    const messages = typeof action.update === 'function' ? action.update(state.messages) : action.update;
    const byId = new Map(messages.map((message) => [message.id, message]));
    const update = (rows: ChatMessage[]) => rows.flatMap((row) => byId.get(row.id) ?? []);
    return composeWindow({ ...state,
      diskTurns: state.diskTurns.map((cell) => ({ ...cell, messages: update(cell.messages) })),
      runs: state.runs.map((run) => run.terminalError && run.phase === 'released' ? run : ({ ...run, messages: update(run.messages) })),
    });
  }
  const { page, mode, sessionId } = action;
  if (mode === 'prepend' && (state.sessionId !== sessionId || action.endTurnIndex !== state.diskCursor?.index)) return state;
  const sameSession = state.sessionId === null || state.sessionId === sessionId;
  const coversTail = mode !== 'prepend' || page.replacesWindow === true;
  const needsStableRead = action.fromCache || (!coversTail && page.stable !== false)
    ? sameSession && state.needsStableRead : page.stable === false;
  // A successful empty source is different from an incomplete read during writes.
  if (!page.messages.length && page.stable === false) {
    return { ...(sameSession ? state : emptyChatHistory), sessionId, needsStableRead };
  }
  const totalTurns = page.totalTurns ?? state.totalTurns;
  const end = action.endTurnIndex ?? totalTurns;
  const start = page.startTurnIndex ?? Math.max(0, end - splitTurns(page.messages).length);
  const keep = sameSession && !page.replacesWindow && mode !== 'replace' && mode !== 'jump';
  const byIndex = new Map((keep ? state.diskTurns : []).map((cell) => [cell.index, cell]));
  if (mode !== 'prepend') for (const index of byIndex.keys()) if (index >= start) byIndex.delete(index);
  let pageMessages = page.messages;
  const pageIds = new Set(pageMessages.map(row => row.id));
  for (const update of action.toolUpdates ?? []) {
    pageMessages = applyStreamEvent(pageMessages, update.event, update).filter(row => pageIds.has(row.id));
  }
  splitTurns(pageMessages).forEach((messages, offset) => {
    const index = start + offset;
    byIndex.set(index, { index, messages: reuseMessages(byIndex.get(index)?.messages ?? [], messages) });
  });
  const diskTurns = [...byIndex.values()].filter((cell) => cell.index < totalTurns).sort((a, b) => a.index - b.index);
  // Only a fresh tail read started after release can retire the covered run.
  const retired = sameSession ? state.runs.filter((run) => coversTail && !action.fromCache && action.reconciles?.includes(run.id)
    && run.phase === 'released' && (!run.terminalError || page.stable !== false)
    && (start <= (locateHistoryRun(run, diskTurns) ?? run.start) || page.replacesWindow)) : [];
  const runs = sameSession ? state.runs.filter((run) => !retired.includes(run)) : [];
  const failures = sameSession ? state.failures : [];
  return composeWindow({ ...state, sessionId, diskTurns, runs, failures, totalTurns, needsStableRead,
    writerIdle: sameSession && state.writerIdle,
    diskCursor: !keep || !state.diskCursor || start <= state.diskCursor.index
      ? { index: start, proof: page.beforeProof } : state.diskCursor,
  }, mode !== 'prepend');
}
