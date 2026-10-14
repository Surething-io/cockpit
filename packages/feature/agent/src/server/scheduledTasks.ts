import { existsSync } from 'fs';
import {
  SCHEDULED_TASKS_FILE, readJsonFile, readJsonFileForUpdate, writeJsonFile, mutateJsonFile, withFileLock,
  getSessionFilePath,
  getClaudeSessionPath, getOllamaSessionPath,
  getDeepseekBuiltinSessionPath, getKimiBuiltinSessionPath,
  getGlmBuiltinSessionPath, findCodexSessionPath,
} from '@cockpit/shared-utils';
import { updateGlobalState } from './state/globalState';
import { isRunActive, getRunSnapshot, getRunSessionId, requestStop } from './sessionRunHub';
import { dispatchChat } from './engines/orchestrator';
import { getEngineSpec } from './engines/registry';
import { Effect } from 'effect';
import i18n from '@cockpit/shared-i18n';
import { AgentError, type AgentProvider } from '@cockpit/effect-core';
import { AppRuntime } from '@cockpit/effect-runtime/server';

// ============================================
// Types
// ============================================

export interface ScheduledTask {
  id: string;
  cwd: string;
  tabId: string;
  sessionId: string;       // chat session id
  engine?: string;         // ChatEngine at creation; absent = 'claude' (pre-persistence tasks)
  model?: string;          // ollama/deepseek/kimi/glm: model name snapshot at creation
  language?: string;       // UI language snapshot at creation; picks the taskFile prompt wording
  message: string;         // mutually exclusive with taskFile — exactly one is set
  taskFile?: string;       // absolute path to a file describing the task; referenced, never inlined
  type: 'once' | 'interval' | 'cron';
  delayMinutes?: number;   // type=once
  intervalMinutes?: number; // type=interval
  activeFrom?: string;     // type=interval active time range start, "09:00"
  activeTo?: string;       // type=interval active time range end, "18:00"
  startAt?: number;        // type=interval first fire (ms); runs stay on startAt + k * interval
  cron?: string;           // type=cron, e.g. "0 9 * * *"
  nextFireTime: number;    // timestamp ms
  paused: boolean;
  completed?: boolean;     // type=once: set when its scheduled run is claimed
  unread?: boolean;
  lastFiredAt?: number;
  lastResult?: 'success' | 'error' | 'interrupted'; // interrupted: process died mid-run
  firingSince?: number;    // set while a run is in flight (claimed on disk before sending)
  consecutiveFailures?: number; // resets on success; recurring tasks auto-pause at the threshold
  createdAt: number;
  sortIndex?: number;
}

/** Recurring tasks auto-pause after this many consecutive failures (circuit breaker). */
const MAX_CONSECUTIVE_FAILURES = 3;

/**
 * How long a single scheduled run may stay active before it is stopped and recorded as a
 * failure. It is a runaway guard, not a latency budget: research-style tasks (multi-source
 * scans, nested sub-agents) legitimately run well past half an hour, and cutting one short
 * loses the whole turn's work. Kept generous for that reason — the deadline exists so a
 * wedged run cannot hold the reentrancy guard and block every later round forever.
 */
const RUN_DEADLINE_MS = 60 * 60 * 1000;

/**
 * How late a `once` task may still be fired after the moment it was due.
 *
 * Timers are plain setTimeout and do not survive the process, so a `once` task whose
 * moment passes while cockpit is down has no timer to resume. Within this window the
 * user's intent is still current ("in 10 minutes" during a restart), so the task runs
 * a little late rather than not at all; past it, running would act on a stale intent.
 */
const MISSED_ONCE_GRACE_MS = 60 * 60 * 1000;

/**
 * The prompt a task actually dispatches.
 *
 * A taskFile task REFERENCES the file and lets the agent read it — the content is
 * never inlined. That is the whole point of the field: edits to the file take effect
 * on the next fire instead of being frozen at creation time, and the stored task stays
 * small no matter how long the document grows.
 *
 * The wording mirrors resolveCommandPrompt's skill reference list (see
 * server/lib/slashCommands.ts) so the agent gets a phrasing it already handles — an
 * explicit "read this first" beats "do what X says", which models will sometimes
 * answer from the filename alone without ever opening the file.
 *
 * The language is taken from the task, NOT from the i18n singleton's current
 * language: this runs on a background timer where "the current UI language" is
 * whatever the last request happened to set, which would make one task dispatch
 * different wording at different times. Passing `lng` explicitly reads the chosen
 * bundle without mutating the singleton.
 */
export function buildTaskPrompt(
  task: Pick<ScheduledTask, 'message' | 'taskFile' | 'language'>,
): string {
  if (!task.taskFile) return task.message;
  const header = i18n.t('scheduledTasks.taskFilePromptHeader', {
    lng: task.language || 'en',
  });
  return `${header}\n- ${task.taskFile}`;
}

// ============================================
// Cron Parser (minimal, supports: min hour dom month dow)
// ============================================

function parseCronField(field: string, min: number, max: number): number[] {
  const values: number[] = [];
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.push(i);
    } else if (part.includes('/')) {
      const [range, stepStr] = part.split('/');
      const step = parseInt(stepStr, 10);
      const start = range === '*' ? min : parseInt(range, 10);
      for (let i = start; i <= max; i += step) values.push(i);
    } else if (part.includes('-')) {
      const [a, b] = part.split('-').map(Number);
      for (let i = a; i <= b; i++) values.push(i);
    } else {
      values.push(parseInt(part, 10));
    }
  }
  return values;
}

/**
 * Calculate the next fire time for a cron expression.
 */
export function getNextCronTime(cronExpr: string, after: Date = new Date()): number {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return after.getTime() + 60000; // fallback 1 min

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 6); // 0=Sunday

  // Scan minute-by-minute starting from after + 1 min; cap at 366 days
  const candidate = new Date(after);
  candidate.setSeconds(0, 0);
  candidate.setMinutes(candidate.getMinutes() + 1);

  const limit = 366 * 24 * 60; // max iterations
  for (let i = 0; i < limit; i++) {
    const m = candidate.getMinutes();
    const h = candidate.getHours();
    const d = candidate.getDate();
    const mo = candidate.getMonth() + 1;
    const dow = candidate.getDay();

    if (
      minutes.includes(m) &&
      hours.includes(h) &&
      doms.includes(d) &&
      months.includes(mo) &&
      dows.includes(dow)
    ) {
      return candidate.getTime();
    }
    candidate.setMinutes(candidate.getMinutes() + 1);
  }
  return after.getTime() + 86400000; // fallback 1 day
}

// ============================================
// Send Chat Message — unified loopback-HTTP execution (#10 ws-converge)
// ============================================

/**
 * Bind a task to the session id its run revealed, and persist it immediately.
 *
 * `key` stays valid across the rekey: rekeyRun ADDS the real session id as an alias
 * without dropping the provisional runId, so reading by the original key keeps working
 * both while the run is live and through the post-run grace window.
 *
 * @returns true once the id is known — the caller polls until then.
 */
async function rebindTaskSession(task: ScheduledTask, key: string): Promise<boolean> {
  const newSessionId = getRunSessionId(key);
  if (!newSessionId) return false; // engine has not announced it yet
  if (newSessionId === task.sessionId) return true; // nothing to move
  console.warn(`[ScheduledTask] task ${task.id}: rebound session ${task.sessionId} → ${newSessionId}`);
  task.sessionId = newSessionId;
  await scheduledTaskManager.persistSessionRebind(task.id, newSessionId);
  return true;
}

/**
 * Single execution path for ALL engines (claude / ollama / codex / kimi /
 * deepseek / glm). Since #10 ws-converge every engine's /api/chat[/<engine>] route only STARTS a
 * detached run and returns its runKey as JSON (no SSE to drain); the route owns session
 * persistence, 'loading'/'unread' global state, the run registry and the 409 concurrent-run
 * guard. We POST to start the run, then poll the registry until it leaves "running".
 *
 * claude used to bypass the route with a direct SDK query(), which left it OUT of
 * the run registry — so the 409 guard couldn't see them and two writers could corrupt the
 * jsonl. Routing them through /api/chat closes that hole and makes scheduled claude runs
 * stream live to viewers like every other engine. The route covers everything the old
 * direct path did (resume, cwd, bypassPermissions, settingSources, the 1-compaction
 * retry) and additionally expands slash commands.
 *
 * Scheduled tasks always resume an existing session, so the runKey is the task's sessionId.
 */
const dispatchEngineMessageEff = (
  task: ScheduledTask,
  engine: string,
  startFresh: boolean,
): Effect.Effect<boolean, AgentError> =>
  Effect.tryPromise({
    try: async () => {
      const spec = getEngineSpec(engine);
      if (!spec) {
        throw new Error(`no engine spec for ${engine}`);
      }
      // In-process dispatch — backend triggers backend directly via the orchestrator. No HTTP
      // loopback, so scheduled tasks need no port and can't mis-target a sibling dev/prod
      // instance. The run registers in sessionRunHub and streams to viewers via
      // /ws/session-stream exactly like an interactive request.
      const noHistory = await readSessionNoHistory(task, engine);
      const outputStyleId = await readSessionOutputStyleId(task);
      const outcome = await dispatchChat(spec, {
        prompt: buildTaskPrompt(task),
        // Omit sessionId to start a brand-new session when the resume target is gone;
        // the engine generates a fresh id (captured below via getRunSessionId).
        ...(startFresh ? {} : { sessionId: task.sessionId }),
        cwd: task.cwd,
        engine,
        ...(task.model && { model: task.model }),
        ...(noHistory && { noHistory: true }),
        ...(outputStyleId && { outputStyleId }),
      });
      if (!outcome.ok) {
        // 409 = session/run already active (the guard fired). Surface as a task error
        // (recorded in lastResult) rather than silently skipping.
        throw new Error(`${engine} dispatch rejected (${outcome.status}): ${outcome.error}`);
      }
      const key = outcome.runKey;
      // Fresh session: bind as soon as the engine reveals its real id (ctx.rekey →
      // rekeyRun, seconds into the run), not when the turn ends. The end of the run is up
      // to RUN_DEADLINE_MS away, and for that whole window the task points at a session
      // that no longer exists: the panel opens an empty transcript while the real one
      // streams under another id, a crash or restart mid-run loses the id for good, and an
      // outcome-gated rebind skipped it entirely on timeout/error — so the next round
      // started yet another from-scratch session against the same dead id. Self-
      // reinforcing, since a from-scratch run carries no context and is the one most
      // likely to hit the deadline again.
      //
      // Persisting is part of binding (see persistSessionRebind): the run's settle patch
      // does not carry the session id, so without it the new id would never reach disk.
      let rebound = !startFresh; // a plain resume already points at the right session
      const deadline = Date.now() + RUN_DEADLINE_MS;
      while (isRunActive(key) && Date.now() < deadline) {
        if (!rebound) rebound = await rebindTaskSession(task, key);
        await new Promise((r) => setTimeout(r, 500));
      }
      // A run short enough to finish inside the first tick never got polled above; the
      // registry keeps the id readable through the post-run grace window.
      if (!rebound) await rebindTaskSession(task, key);
      // Map the run's TERMINAL state to a result instead of always reporting success — the
      // poll above only knows "not running", which conflates idle/error/timeout. The run
      // lingers in the registry for a grace window after markRunIdle, so the status read
      // right after the loop is reliable.
      if (isRunActive(key)) {
        // Deadline hit while still running: abort the detached run instead of leaving a
        // zombie that keeps writing the jsonl and tripping the next round's 409 guard.
        requestStop(key);
        throw new Error(`${engine} run timed out after ${RUN_DEADLINE_MS / 60000}m (session ${task.sessionId})`);
      }
      const snap = getRunSnapshot(key);
      if (!snap || snap.status === 'error') {
        // null = the run isn't in the registry: never started (see runKey check) or evicted
        // before we read it (impossible inside the 60s grace, since the poll exits within
        // 500ms of markRunIdle). Treat as failure — fail closed, not a silent success.
        throw new Error(`${engine} run failed (session ${task.sessionId})`);
      }
      return true as const;
    },
    catch: (cause) =>
      new AgentError({
        provider: engine as AgentProvider,
        kind: 'unknown',
        cause,
      }),
  });

/** Transcript path per Built-in Agent engine, so adding one is a map entry rather than
 *  another `if (engine === ...)` branch. */
const BUILTIN_LOOP_PATHS: Record<string, (cwd: string, sessionId: string) => string> = {
  ollama: getOllamaSessionPath,
  deepseek: getDeepseekBuiltinSessionPath,
  kimi: getKimiBuiltinSessionPath,
  glm: getGlmBuiltinSessionPath,
};

/** Per-session slice of the project state file the chat tabs persist (see /api/project-state). */
interface ProjectSessionState {
  noHistories?: Record<string, boolean>;
  outputStyles?: Record<string, string>;
}

/**
 * "Independent task" (the noHistory toggle) for this session, READ AT FIRE TIME.
 *
 * It is a per-session UI preference, not a task field, so it is read at fire time rather
 * than snapshotted onto the task. Flipping the checkbox therefore takes effect on the next
 * fire instead of being frozen at task creation — and a task whose session has it on stops
 * replaying a transcript the user explicitly asked not to send.
 *
 * Gated on the engines that actually honor it, mirroring the client's `canDropHistory`:
 * the built-in agent loop reads params.noHistory directly (ollama, deepseek, kimi, glm),
 * claude honors it in the SDK loop by stashing the transcript for the turn, and codex
 * stashes its rollout. Every engine cockpit ships is on one of those two paths, so this
 * gate is currently total — it stays as the explicit contract for the next engine added.
 */
export async function readSessionNoHistory(
  task: ScheduledTask,
  engine: string,
): Promise<boolean> {
  if (!BUILTIN_LOOP_PATHS[engine] && engine !== 'claude' && engine !== 'codex') return false;
  const state = await readJsonFile<ProjectSessionState>(getSessionFilePath(task.cwd), {});
  return state.noHistories?.[task.sessionId] === true;
}

/**
 * Output style selected for this session, READ AT FIRE TIME — same reasoning as
 * readSessionNoHistory: it is a per-session UI preference, so switching it in the toolbar
 * applies to the next fire instead of being frozen at task creation. Every engine injects it,
 * so there is no engine gate. The id is resolved to text by the orchestrator.
 */
export async function readSessionOutputStyleId(task: ScheduledTask): Promise<string | undefined> {
  const state = await readJsonFile<ProjectSessionState>(getSessionFilePath(task.cwd), {});
  const id = state.outputStyles?.[task.sessionId];
  return typeof id === 'string' && id ? id : undefined;
}

/**
 * Resume-target session file per engine (used for the pre-flight existence check).
 * Codex stores sessions outside the cwd-encoded layout, so its helper globs by
 * sessionId and returns null when not found.
 */
function sessionPathFor(engine: string, task: ScheduledTask): string | null {
  const builtinPath = BUILTIN_LOOP_PATHS[engine];
  if (builtinPath) return builtinPath(task.cwd, task.sessionId);
  if (engine === 'codex') return findCodexSessionPath(task.sessionId);
  return getClaudeSessionPath(task.cwd, task.sessionId);
}

/**
 * Engine dispatcher. Tasks without an engine field predate engine persistence
 * and are treated as 'claude' (their historical behavior).
 *
 * Pre-flight: the resume-target session file must exist, otherwise fail with
 * a semantic 'session-not-found' instead of the engine's opaque error.
 */
export const sendChatMessageEff = (task: ScheduledTask): Effect.Effect<boolean, never> =>
  Effect.gen(function* () {
    const engine = task.engine ?? 'claude';

    if (!['claude', 'ollama', 'codex', 'kimi', 'deepseek', 'glm'].includes(engine)) {
      return yield* Effect.fail(
        new AgentError({
          provider: 'claude',
          kind: 'unsupported-engine',
          cause: new Error(`scheduled tasks not supported for engine '${engine}' (task ${task.id})`),
        }),
      );
    }

    // Pre-flight the taskFile. Dispatching a reference to a file that no longer exists
    // burns a full turn and — worse — the agent replies normally ("that file is missing"),
    // so the run reports SUCCESS and the task shows green in the panel. Failing here is
    // what makes a moved/deleted task file visible as a red task.
    if (task.taskFile && !existsSync(task.taskFile)) {
      return yield* Effect.fail(
        new AgentError({
          provider: engine as AgentProvider,
          kind: 'unknown',
          cause: new Error(`task file not found: ${task.taskFile} (task ${task.id})`),
        }),
      );
    }

    // Resume target gone (cleared history, session-id rotation, retention pruning,
    // or a codex glob miss) → don't fail; start a FRESH session running the same
    // message and write the new session id back to the task (see dispatchEngineMessageEff).
    const sessionPath = sessionPathFor(engine, task);
    const startFresh = !sessionPath || !existsSync(sessionPath);
    if (startFresh) {
      console.warn(
        `[ScheduledTask] resume session missing (${sessionPath ?? `no session for ${task.sessionId}`}) for task ${task.id}, engine ${engine}; starting a fresh session`,
      );
    }

    return yield* dispatchEngineMessageEff(task, engine, startFresh);
  }).pipe(
    Effect.catchAll((err) =>
      Effect.gen(function* () {
        console.error(`[ScheduledTask] Failed to send message for task ${task.id}:`, err);
        // Even on failure, mark the task unread
        yield* Effect.tryPromise(() =>
          // Pass the engine here too: this branch also covers dispatch never
          // starting (bad engine, 409, missing task file), so the orchestrator
          // never got to record it.
          updateGlobalState(task.cwd, task.sessionId, 'unread', undefined, undefined, task.engine),
        ).pipe(Effect.orElse(() => Effect.void));
        return false as const;
      })
    ),
  );

/**
 * Promise<boolean> entry point that delegates to the Effect version internally,
 * so the manager's scheduling logic stays Promise/async.
 */
async function sendChatMessage(task: ScheduledTask): Promise<boolean> {
  return AppRuntime.runPromise(sendChatMessageEff(task));
}

// ============================================
// Task lifecycle — one transition table (State, as data)
// ============================================

/**
 * Where a task is in its run lifecycle, derived from fields already on disk.
 * `firing` comes first: a run in flight stays in flight even if the user pauses
 * the task meanwhile (the pause applies once the run settles).
 */
export type TaskState = 'pending' | 'firing' | 'done' | 'interrupted' | 'paused';

/** Run-lifecycle events. Edits, pause and resume are plain field patches, not events. */
export type TaskEvent = 'due' | 'trigger' | 'settle' | 'boot';

export function taskState(t: ScheduledTask): TaskState {
  if (t.firingSince) return 'firing';
  if (t.paused) return 'paused';
  if (t.completed) return 'done';
  if (t.lastResult === 'interrupted') return 'interrupted';
  return 'pending';
}

/**
 * The only legal run-lifecycle moves. Anything not listed is rejected — notably a
 * second run while one is in flight, and a scheduled fire of a finished task.
 * `settle` lands on pending / done / paused depending on the task (see settleRun).
 */
export const TRANSITIONS: ReadonlyArray<{ from: TaskState; event: TaskEvent; to: TaskState | 'settled' }> = [
  { from: 'pending', event: 'due', to: 'firing' },
  { from: 'pending', event: 'trigger', to: 'firing' },
  { from: 'interrupted', event: 'due', to: 'firing' },
  { from: 'interrupted', event: 'trigger', to: 'firing' },
  { from: 'paused', event: 'trigger', to: 'firing' }, // manual run ignores pause
  { from: 'done', event: 'trigger', to: 'firing' }, // manual re-run of a finished once task
  { from: 'firing', event: 'settle', to: 'settled' },
  { from: 'firing', event: 'boot', to: 'interrupted' }, // the process died mid-run
];

export function canTransition(t: ScheduledTask, event: TaskEvent): boolean {
  const from = taskState(t);
  return TRANSITIONS.some((r) => r.from === from && r.event === event);
}

// ============================================
// Task patches — every change is a command applied to the current record
// ============================================

/** A change to one task, computed from its CURRENT stored state; null = no change. */
type TaskPatch = (task: ScheduledTask) => Partial<ScheduledTask> | null;

/** Fields only the scheduler writes; stripped from add / update input. */
const SERVER_OWNED: ReadonlyArray<keyof ScheduledTask> = ['firingSince'];

function withoutServerOwned<T extends Partial<ScheduledTask>>(fields: T): T {
  const copy = { ...fields };
  for (const k of SERVER_OWNED) delete copy[k];
  return copy;
}

/**
 * First point of the grid `anchor + k * interval` strictly after `now` (the anchor
 * itself while it is still ahead). Interval tasks fire on this fixed grid rather than
 * "last run end + interval", so run duration never accumulates as drift, and a missed
 * slot (process down, machine asleep, outside the active range) is skipped, not replayed.
 */
export function nextIntervalFire(anchor: number, intervalMinutes: number, now: number): number {
  if (anchor > now) return anchor;
  const step = intervalMinutes * 60000;
  return anchor + (Math.floor((now - anchor) / step) + 1) * step;
}

/** Next occurrence of a recurring task; a once task keeps its own time. */
function nextOccurrence(t: ScheduledTask, now: number): number {
  // nextFireTime is always a grid point (create / edit seed it from startAt or
  // "now + interval"), so stepping from it keeps the same grid with no extra state.
  if (t.type === 'interval' && t.intervalMinutes) return nextIntervalFire(t.nextFireTime, t.intervalMinutes, now);
  if (t.type === 'cron' && t.cron) return getNextCronTime(t.cron, new Date(now));
  return t.nextFireTime;
}

/**
 * Check whether `now` falls within the active time range of an interval task.
 * Supports cross-midnight ranges such as 22:00 ~ 06:00.
 */
function isInActiveRange(task: ScheduledTask, now = new Date()): boolean {
  if (task.type !== 'interval' || !task.activeFrom || !task.activeTo) return true;
  const [fh, fm] = task.activeFrom.split(':').map(Number);
  const [th, tm] = task.activeTo.split(':').map(Number);
  const current = now.getHours() * 60 + now.getMinutes();
  const from = fh * 60 + fm;
  const to = th * 60 + tm;
  return from <= to ? current >= from && current <= to : current >= from || current <= to;
}

/**
 * Claim a run on disk before anything is sent. A scheduled `once` run is marked
 * completed here, not after the run: if the process dies mid-run the task must
 * not come back as pending (at most once).
 */
const claimRun = (event: 'due' | 'trigger', now: number): TaskPatch => (t) => ({
  firingSince: now,
  ...(event === 'due' && t.type === 'once' ? { completed: true } : {}),
});

/**
 * Record a finished run on the current record. A manual run keeps the schedule
 * and never trips the circuit breaker; a scheduled one completes a once task,
 * auto-pauses a recurring task that keeps failing, or advances it.
 */
const settleRun = (event: 'due' | 'trigger', success: boolean, now: number): TaskPatch => (t) => {
  const consecutiveFailures = success ? 0 : (t.consecutiveFailures ?? 0) + 1;
  const base: Partial<ScheduledTask> = {
    firingSince: undefined,
    lastFiredAt: now,
    lastResult: success ? 'success' : 'error',
    consecutiveFailures,
    unread: true,
  };
  if (event === 'trigger') return base;
  if (t.type === 'once') return { ...base, completed: true };
  if (!success && consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) return { ...base, paused: true };
  return { ...base, nextFireTime: nextOccurrence(t, now) };
};

/** A claim found on startup: the previous process died mid-run. Never re-sent. */
const interruptRun: TaskPatch = () => ({
  firingSince: undefined,
  lastResult: 'interrupted',
  unread: true,
});

// ============================================
// TaskStore — the only reader / writer of scheduled-tasks.json
// ============================================

/**
 * scheduled-tasks.json is the single source of truth. Every write is a patch
 * applied by task id to the record as it is on disk right now, under the file
 * lock, so concurrent changes (a run settling, the user marking read, an edit)
 * never overwrite one another. The strict read refuses a corrupt file rather
 * than writing defaults over it.
 */
class TaskStore {
  constructor(private readonly file: string) {}

  read(): Promise<ScheduledTask[]> {
    return withFileLock(this.file, () => readJsonFileForUpdate<ScheduledTask[]>(this.file, []));
  }

  /** Apply `patch` to task `id`; the updated task, or null if absent or unchanged. */
  update(id: string, patch: TaskPatch): Promise<ScheduledTask | null> {
    return withFileLock(this.file, async () => {
      const all = await readJsonFileForUpdate<ScheduledTask[]>(this.file, []);
      const i = all.findIndex((t) => t.id === id);
      if (i === -1) return null;
      const fields = patch(all[i]);
      if (!fields) return null;
      all[i] = { ...all[i], ...fields };
      await writeJsonFile(this.file, all);
      return all[i];
    });
  }

  /** Apply `patch` to every task; writes only when something changed. */
  updateAll(patch: TaskPatch): Promise<number> {
    return withFileLock(this.file, async () => {
      const all = await readJsonFileForUpdate<ScheduledTask[]>(this.file, []);
      let changed = 0;
      for (let i = 0; i < all.length; i++) {
        const fields = patch(all[i]);
        if (!fields) continue;
        all[i] = { ...all[i], ...fields };
        changed++;
      }
      if (changed) await writeJsonFile(this.file, all);
      return changed;
    });
  }

  add(task: ScheduledTask): Promise<ScheduledTask[]> {
    return mutateJsonFile<ScheduledTask[]>(this.file, [], (all) => [...all, task]);
  }

  remove(id: string): Promise<boolean> {
    return withFileLock(this.file, async () => {
      const all = await readJsonFileForUpdate<ScheduledTask[]>(this.file, []);
      const i = all.findIndex((t) => t.id === id);
      if (i === -1) return false;
      all.splice(i, 1);
      await writeJsonFile(this.file, all);
      return true;
    });
  }
}

// ============================================
// ScheduledTaskManager Singleton
// ============================================

type TaskFiredCallback = (task: ScheduledTask) => void;

class ScheduledTaskManager {
  private readonly store = new TaskStore(SCHEDULED_TASKS_FILE);
  /** Timers by task id. Holds no task state — every decision re-reads the store. */
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  /** Set when the task file exists but does not parse; see init(). */
  private loadFailed = false;
  private onTaskFired: TaskFiredCallback | null = null;

  /**
   * Ensure the manager is initialized (lazy init; supports calls from different module instances in API routes).
   */
  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this.init();
    return this.initPromise;
  }

  /**
   * Initialize: recover runs cut off by the previous process, then arm timers. Tasks
   * belong to this data dir (COCKPIT_DIR), not a port — a single instance per data
   * dir is enforced at startup (server.mjs's health-probe lock).
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    // The strict read throws on a malformed file (deliberately — see
    // readJsonFileForUpdate). This is the boot path: server.mjs awaits init() with
    // no error boundary, so letting it propagate would turn one bad byte in
    // scheduled-tasks.json into "Cockpit will not start". Run with no timers, say
    // so loudly, and leave the file alone — every write path uses the same strict
    // read, so nothing overwrites what the user has to repair by hand.
    let tasks: ScheduledTask[];
    try {
      tasks = await this.store.read();
    } catch (error) {
      this.loadFailed = true;
      console.error(
        `[ScheduledTaskManager] ${SCHEDULED_TASKS_FILE} could not be read — NO scheduled task will fire until it is fixed. The file has been left untouched:`,
        error,
      );
      return;
    }

    console.log(`[ScheduledTaskManager] Loaded ${tasks.length} scheduled tasks`);

    // A claim on disk at startup means the previous process died mid-run. Record it
    // as interrupted; never re-send it (at most once).
    for (const t of tasks) {
      if (!canTransition(t, 'boot')) continue;
      console.warn(`[ScheduledTask] task ${t.id} was cut off mid-run by the previous process; marking interrupted`);
      await this.store.update(t.id, interruptRun);
    }

    for (const t of await this.store.read()) {
      await this.arm(t);
    }
  }

  /** True when init() could not parse the task file: no timers, and no writes. */
  isLoadFailed(): boolean {
    return this.loadFailed;
  }

  /**
   * Register a task-fired callback (used for WS broadcast).
   */
  setOnTaskFired(cb: TaskFiredCallback): void {
    this.onTaskFired = cb;
  }

  /**
   * Return all tasks, sorted by sortIndex (tasks without one fall back to createdAt).
   */
  async getTasks(): Promise<ScheduledTask[]> {
    await this.ensureInit();
    const tasks = await this.store.read();
    tasks.sort((a, b) => (a.sortIndex ?? a.createdAt) - (b.sortIndex ?? b.createdAt));
    return tasks;
  }

  /**
   * Return the count of unread tasks.
   */
  async getUnreadCount(): Promise<number> {
    await this.ensureInit();
    return (await this.store.read()).filter((t) => t.unread).length;
  }

  /**
   * Add a task.
   */
  async addTask(task: ScheduledTask): Promise<ScheduledTask> {
    await this.ensureInit();
    const fullTask = withoutServerOwned({ ...task });
    await this.store.add(fullTask);
    await this.arm(fullTask);
    return fullTask;
  }

  /**
   * Update a task: patch the given fields onto its current record and re-arm its timer.
   */
  async updateTask(id: string, fields: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    await this.ensureInit();
    const patch = withoutServerOwned(fields);
    const task = await this.store.update(id, () => patch);
    if (task) await this.arm(task);
    return task;
  }

  /**
   * Delete a task.
   */
  async deleteTask(id: string): Promise<boolean> {
    await this.ensureInit();
    const removed = await this.store.remove(id);
    if (removed) this.clearTimer(id);
    return removed;
  }

  /**
   * Pause a task.
   */
  async pauseTask(id: string): Promise<ScheduledTask | null> {
    return this.updateTask(id, { paused: true });
  }

  /**
   * Resume a task: recalculate an expired fire time and reset the failure counter, so a
   * resumed task (incl. one auto-paused by the circuit breaker) gets a fresh set of
   * attempts instead of re-tripping on the first failure.
   */
  async resumeTask(id: string): Promise<ScheduledTask | null> {
    await this.ensureInit();
    const now = Date.now();
    const task = await this.store.update(id, (t) => ({
      paused: false,
      consecutiveFailures: 0,
      // An expired once task is rescheduled a minute out.
      nextFireTime: t.nextFireTime > now ? t.nextFireTime : t.type === 'once' ? now + 60000 : nextOccurrence(t, now),
    }));
    if (task) await this.arm(task);
    return task;
  }

  /**
   * Manually trigger a task. Runs in the background and returns immediately (a run can
   * take minutes); does not change the existing schedule.
   *
   * @returns false when no task has this id. True means the task exists and the run
   * was queued — NOT that it started: a task already in flight rejects the claim.
   */
  async triggerTask(id: string): Promise<boolean> {
    await this.ensureInit();
    const exists = (await this.store.read()).some((t) => t.id === id);
    if (!exists) return false;
    this.runTask(id, 'trigger').catch((err) => {
      console.error(`[ScheduledTask] Manual trigger failed for ${id}:`, err);
    });
    return true;
  }

  /**
   * Persist a mid-run session rebind (see rebindTaskSession) without waiting for the run
   * to end, and tell the board, which otherwise keeps the dead id — and its preview pane
   * keeps polling a transcript that does not exist — for the entire run.
   */
  async persistSessionRebind(id: string, sessionId: string): Promise<void> {
    // Unmanaged task — a direct sendChatMessageEff call (tests), or one deleted mid-run.
    const task = await this.store.update(id, () => ({ sessionId }));
    if (task) this.onTaskFired?.(task);
  }

  /**
   * Mark a task as read.
   *
   * @returns false when no task has this id. The return value used to be
   * discarded, which is why markRead answered 200 for a task that does not
   * exist while pause/resume/update answered 404.
   */
  async markRead(id: string): Promise<boolean> {
    await this.ensureInit();
    return (await this.store.update(id, () => ({ unread: false }))) !== null;
  }

  /**
   * Mark tasks as read by sessionId (called when user views a tab).
   */
  async markReadBySessionId(sessionId: string): Promise<void> {
    await this.ensureInit();
    await this.store.updateAll((t) => (t.sessionId === sessionId && t.unread ? { unread: false } : null));
  }

  /**
   * Mark all tasks as read.
   */
  async markAllRead(): Promise<void> {
    await this.ensureInit();
    await this.store.updateAll((t) => (t.unread ? { unread: false } : null));
  }

  /**
   * Reorder tasks by writing sortIndex values based on the given id array order.
   */
  async reorderTasks(orderedIds: string[]): Promise<void> {
    await this.ensureInit();
    await this.store.updateAll((t) => {
      const i = orderedIds.indexOf(t.id);
      return i === -1 || t.sortIndex === i ? null : { sortIndex: i };
    });
  }

  // ---- Internal ----

  /**
   * (Re)arm the timer for a task from its stored state. An expired recurring task gets
   * its next occurrence; an expired `once` task fires on this boot if it came due within
   * MISSED_ONCE_GRACE_MS (timers do not survive the process), and is retired unrun past it.
   */
  private async arm(task: ScheduledTask): Promise<void> {
    this.clearTimer(task.id);
    if (task.paused || task.completed || task.firingSince) return;

    const now = Date.now();
    let fireAt = task.nextFireTime;
    if (fireAt <= now) {
      if (task.type !== 'once') {
        fireAt = nextOccurrence(task, now);
        await this.store.update(task.id, () => ({ nextFireTime: fireAt }));
      } else if (now - fireAt <= MISSED_ONCE_GRACE_MS) {
        console.log(
          `[ScheduledTask] once task ${task.id} came due ${Math.round((now - fireAt) / 1000)}s ago while down; firing now`,
        );
      } else {
        // Missed by more than the grace window: retire it, but leave a trail. Flipping
        // `completed` alone made an un-run task render identically to a failed one, with
        // nothing in the log and no unread marker to say it never ran.
        await this.store.update(task.id, () => ({ completed: true, unread: true }));
        console.warn(
          `[ScheduledTask] once task ${task.id} missed its fire time by ${Math.round((now - fireAt) / 60000)}min (grace ${MISSED_ONCE_GRACE_MS / 60000}min); not running`,
        );
        return;
      }
    }

    // Clamped: the missed-`once` catch-up path above leaves the fire time in the past.
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      this.runTask(task.id, 'due').catch((err) => {
        console.error(`[ScheduledTask] Scheduled run failed for ${task.id}:`, err);
      });
    }, Math.max(0, fireAt - now));
    this.timers.set(task.id, timer);
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /**
   * One run, scheduled or manual (Template Method): guard → claim → send → settle →
   * re-arm → notify. The guard and the claim happen in ONE locked patch, so two
   * triggers racing for the same task cannot both start a run, and the claim reaches
   * disk before anything is sent.
   */
  private async runTask(id: string, event: 'due' | 'trigger'): Promise<void> {
    // Assigned inside the locked patch below; `as` keeps TS from narrowing it to 'rejected'.
    let outcome = 'rejected' as 'claimed' | 'outside-range' | 'rejected';
    const claimed = await this.store.update(id, (t) => {
      if (!canTransition(t, event)) return null;
      if (event === 'due' && !isInActiveRange(t)) {
        outcome = 'outside-range';
        return { nextFireTime: nextOccurrence(t, Date.now()) };
      }
      outcome = 'claimed';
      return claimRun(event, Date.now())(t);
    });

    if (outcome === 'outside-range' && claimed) {
      console.log(`[ScheduledTask] Skipping task ${id}: outside active range ${claimed.activeFrom}-${claimed.activeTo}`);
      await this.arm(claimed);
      return;
    }
    if (outcome !== 'claimed' || !claimed) {
      console.warn(`[ScheduledTask] Not running ${id} (${event}): not runnable in its current state`);
      return;
    }

    console.log(`[ScheduledTask] ${event === 'due' ? 'Firing' : 'Manual trigger'} ${id}: "${claimed.message}"`);
    let success = false;
    try {
      success = await sendChatMessage(claimed);
    } finally {
      // Settled by id on the CURRENT record: edits made during the run survive, and the
      // result lands even if the task object changed meanwhile.
      const settled = await this.store.update(id, (t) =>
        canTransition(t, 'settle') ? settleRun(event, success, Date.now())(t) : null,
      );
      if (settled) {
        if (settled.paused && !claimed.paused && event === 'due') {
          console.warn(
            `[ScheduledTask] auto-paused task ${id} after ${settled.consecutiveFailures} consecutive failures`,
          );
        }
        await this.arm(settled);
        this.onTaskFired?.(settled);
      }
    }
  }
}

// Global singleton — pinned to globalThis so that the Next.js custom-server
// topology cannot duplicate it. server.mjs imports this file via the Node ESM
// loader (`@cockpit/feature-agent/server/scheduledTasks` through tsx in dev, or
// `./dist/scheduledTasks.mjs` in prod), while API routes import it as
// `@cockpit/feature-agent/server/scheduledTasks` through the
// webpack/turbopack bundle inside `.next/server`. Those two loaders do not
// share a module cache, so a plain `export const x = new X()` would run twice
// in one process — each instance would set its own setTimeout per task and the
// scheduled prompt would be double-dispatched, tripping Anthropic's burst rate
// limit. Following the same pattern as PgPoolManager / RedisManager / etc.
const g = globalThis as unknown as { __scheduledTaskManager?: ScheduledTaskManager };
export const scheduledTaskManager = g.__scheduledTaskManager ?? (g.__scheduledTaskManager = new ScheduledTaskManager());
