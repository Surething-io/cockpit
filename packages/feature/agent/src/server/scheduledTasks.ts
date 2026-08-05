import { existsSync } from 'fs';
import {
  SCHEDULED_TASKS_FILE, readJsonFile, writeJsonFile, mutateJsonFile, withFileLock,
  getSessionFilePath,
  getClaudeSessionPath, getClaude2SessionPath, getOllamaSessionPath,
  getDeepseekSessionPath, getDeepseekBuiltinSessionPath,
  getKimiSessionPath, getKimiBuiltinSessionPath, findCodexSessionPath,
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
  model?: string;          // ollama/deepseek/kimi: model name snapshot at creation
  language?: string;       // UI language snapshot at creation; picks the taskFile prompt wording
  message: string;         // mutually exclusive with taskFile — exactly one is set
  taskFile?: string;       // absolute path to a file describing the task; referenced, never inlined
  type: 'once' | 'interval' | 'cron';
  delayMinutes?: number;   // type=once
  intervalMinutes?: number; // type=interval
  activeFrom?: string;     // type=interval active time range start, "09:00"
  activeTo?: string;       // type=interval active time range end, "18:00"
  cron?: string;           // type=cron, e.g. "0 9 * * *"
  nextFireTime: number;    // timestamp ms
  paused: boolean;
  completed?: boolean;     // type=once: set after firing
  unread?: boolean;
  lastFiredAt?: number;
  lastResult?: 'success' | 'error';
  consecutiveFailures?: number; // resets on success; recurring tasks auto-pause at the threshold
  createdAt: number;
  sortIndex?: number;
}

/** Recurring tasks auto-pause after this many consecutive failures (circuit breaker). */
const MAX_CONSECUTIVE_FAILURES = 3;

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
 * Single execution path for ALL engines (claude / claude2 / ollama / codex / kimi /
 * deepseek). Since #10 ws-converge every engine's /api/chat[/<engine>] route only STARTS a
 * detached run and returns its runKey as JSON (no SSE to drain); the route owns session
 * persistence, 'loading'/'unread' global state, the run registry and the 409 concurrent-run
 * guard. We POST to start the run, then poll the registry until it leaves "running".
 *
 * claude/claude2 used to bypass the route with a direct SDK query(), which left them OUT of
 * the run registry — so the 409 guard couldn't see them and two writers could corrupt the
 * jsonl. Routing them through /api/chat closes that hole and makes scheduled claude runs
 * stream live to viewers like every other engine. The route covers everything the old
 * direct path did (resume, cwd, bypassPermissions, claude2 CLAUDE_CONFIG_DIR via `engine`,
 * settingSources, the 1-compaction retry) and additionally expands slash commands.
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
      // Execution mode is NOT snapshotted on the task — it is derived from where the
      // session actually lives, so a task made from a Built-in Agent tab keeps running
      // the built-in loop instead of silently switching backends mid-schedule.
      const builtinLoop = isBuiltinLoopSession(engine, task);
      const noHistory = await readSessionNoHistory(task, engine, builtinLoop);
      const outcome = await dispatchChat(spec, {
        prompt: buildTaskPrompt(task),
        // Omit sessionId to start a brand-new session when the resume target is gone;
        // the engine generates a fresh id (captured below via getRunSessionId).
        ...(startFresh ? {} : { sessionId: task.sessionId }),
        cwd: task.cwd,
        engine, // selects claude2's CLAUDE_CONFIG_DIR; no-op for the others
        ...(task.model && { model: task.model }),
        ...(builtinLoop && { mode: 'builtin' }),
        ...(noHistory && { noHistory: true }),
      });
      if (!outcome.ok) {
        // 409 = session/run already active (the guard fired). Surface as a task error
        // (recorded in lastResult) rather than silently skipping.
        throw new Error(`${engine} dispatch rejected (${outcome.status}): ${outcome.error}`);
      }
      const key = outcome.runKey;
      // The run is detached from this request; wait for it to finish (registry → not running).
      const deadline = Date.now() + 30 * 60 * 1000;
      while (isRunActive(key) && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 500));
      }
      // Map the run's TERMINAL state to a result instead of always reporting success — the
      // poll above only knows "not running", which conflates idle/error/timeout. The run
      // lingers in the registry for a grace window after markRunIdle, so the status read
      // right after the loop is reliable.
      if (isRunActive(key)) {
        // Deadline hit while still running: abort the detached run instead of leaving a
        // zombie that keeps writing the jsonl and tripping the next round's 409 guard.
        requestStop(key);
        throw new Error(`${engine} run timed out after 30m (session ${task.sessionId})`);
      }
      const snap = getRunSnapshot(key);
      if (!snap || snap.status === 'error') {
        // null = the run isn't in the registry: never started (see runKey check) or evicted
        // before we read it (impossible inside the 60s grace, since the poll exits within
        // 500ms of markRunIdle). Treat as failure — fail closed, not a silent success.
        throw new Error(`${engine} run failed (session ${task.sessionId})`);
      }
      // Fresh session: the engine revealed a new id mid-run (rekeyRun). Read it from the
      // run (key is the provisional runId, still a valid alias) and write it back so the
      // task resumes the new session next time instead of failing on the gone one. Mutates
      // task in place — fireTask/fireTaskManual persist it in their saveToDisk that follows.
      if (startFresh) {
        const newSessionId = getRunSessionId(key);
        if (newSessionId && newSessionId !== task.sessionId) {
          console.warn(`[ScheduledTask] task ${task.id}: rebound session ${task.sessionId} → ${newSessionId}`);
          task.sessionId = newSessionId;
        }
      }
      return true as const;
    },
    // claude2 shares the 'claude' provider for error classification (same SDK).
    catch: (cause) =>
      new AgentError({
        provider: (engine === 'claude2' ? 'claude' : engine) as AgentProvider,
        kind: 'unknown',
        cause,
      }),
  });

/** Built-in Agent transcript path for the engines that have two stores (SDK + built-in). */
const BUILTIN_LOOP_PATHS: Record<string, (cwd: string, sessionId: string) => string> = {
  deepseek: getDeepseekBuiltinSessionPath,
  kimi: getKimiBuiltinSessionPath,
};

/**
 * Does this task's session live in its engine's Built-in Agent store?
 *
 * deepseek and kimi each run the same two loops (Claude Agent SDK / our built-in agent) and
 * write a different store per mode, so the store IS the answer — the task never snapshots a
 * mode. ollama is absent on purpose: it only ever runs the built-in loop, so it needs no
 * probe (see readSessionNoHistory, which special-cases it).
 */
function isBuiltinLoopSession(engine: string, task: ScheduledTask): boolean {
  const resolve = BUILTIN_LOOP_PATHS[engine];
  return !!resolve && existsSync(resolve(task.cwd, task.sessionId));
}

/** Per-session slice of the project state file the chat tabs persist (see /api/project-state). */
interface ProjectSessionState {
  noHistories?: Record<string, boolean>;
}

/**
 * "Independent task" (the noHistory toggle) for this session, READ AT FIRE TIME.
 *
 * It is a per-session UI preference, not a task field, so it follows the same rule as the
 * execution mode above: derived from where the session lives, never snapshotted onto the
 * task. Flipping the checkbox therefore takes effect on the next fire instead of being
 * frozen at task creation — and a task whose session has it on stops replaying a transcript
 * the user explicitly asked not to send.
 *
 * Gated on the engines that actually honor it, mirroring the client's `canDropHistory`:
 * the built-in agent loop reads params.noHistory directly (ollama always runs that loop,
 * deepseek/kimi only in builtin mode), and claude/claude2 honor it in the SDK loop by stashing
 * the transcript for the turn. Scheduled runs always take the SDK path — dispatch never
 * passes mode:'pty' — so the PTY exclusion cannot apply here. Passing the flag to an engine
 * that ignores it would read as support that isn't there.
 */
export async function readSessionNoHistory(
  task: ScheduledTask,
  engine: string,
  builtinLoop: boolean,
): Promise<boolean> {
  const sdkClaude = engine === 'claude' || engine === 'claude2';
  if (engine !== 'ollama' && !builtinLoop && !sdkClaude) return false;
  const state = await readJsonFile<ProjectSessionState>(getSessionFilePath(task.cwd), {});
  return state.noHistories?.[task.sessionId] === true;
}

/**
 * Resume-target session file per engine (used for the pre-flight existence check).
 * Codex stores sessions outside the cwd-encoded layout, so its helper globs by
 * sessionId and returns null when not found.
 */
function sessionPathFor(engine: string, task: ScheduledTask): string | null {
  if (engine === 'claude2') return getClaude2SessionPath(task.cwd, task.sessionId);
  if (engine === 'ollama') return getOllamaSessionPath(task.cwd, task.sessionId);
  // DeepSeek/Kimi have one store per execution mode; the built-in one is checked first so a
  // built-in session isn't reported missing (which would restart it as a fresh SDK run).
  if (isBuiltinLoopSession(engine, task)) return BUILTIN_LOOP_PATHS[engine](task.cwd, task.sessionId);
  if (engine === 'deepseek') return getDeepseekSessionPath(task.cwd, task.sessionId);
  if (engine === 'kimi') return getKimiSessionPath(task.cwd, task.sessionId);
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

    if (!['claude', 'claude2', 'ollama', 'codex', 'kimi', 'deepseek'].includes(engine)) {
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
          provider: (engine === 'claude2' ? 'claude' : engine) as AgentProvider,
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
          updateGlobalState(task.cwd, task.sessionId, 'unread'),
        ).pipe(Effect.orElse(() => Effect.void));
        return false as const;
      })
    ),
  );

/**
 * Promise<boolean> entry point that delegates to the Effect version internally.
 * fireTask / fireTaskManual continue to use Promise/async so the manager's
 * scheduling logic stays unchanged.
 */
async function sendChatMessage(task: ScheduledTask): Promise<boolean> {
  return AppRuntime.runPromise(sendChatMessageEff(task));
}

// ============================================
// ScheduledTaskManager Singleton
// ============================================

type TaskFiredCallback = (task: ScheduledTask) => void;

class ScheduledTaskManager {
  private tasks: ScheduledTask[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  /** Tasks currently inside fireTask — prevents reentrant double-fire (manual trigger + cron, HMR-leaked timer, etc.) */
  private firing = new Set<string>();
  private initialized = false;
  private initPromise: Promise<void> | null = null;
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
   * Initialize: load tasks from disk and rebuild timers. Tasks belong to this data dir
   * (COCKPIT_DIR), not a port — a single instance per data dir is enforced at startup
   * (server.mjs's health-probe lock), so loading the whole file is correct and safe.
   */
  async init(): Promise<void> {
    if (this.initialized) return;
    this.initialized = true;

    this.tasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);

    console.log(`[ScheduledTaskManager] Loaded ${this.tasks.length} scheduled tasks`);

    // Rebuild timers (expired tasks get their nextFireTime recalculated or are marked completed)
    for (const task of this.tasks) {
      if (!task.paused && !task.completed) {
        this.scheduleTask(task);
      }
    }
    // scheduleTask may have modified nextFireTime / completed for expired tasks; persist
    await this.saveToDisk();
  }

  /**
   * Register a task-fired callback (used for WS broadcast).
   */
  setOnTaskFired(cb: TaskFiredCallback): void {
    this.onTaskFired = cb;
  }

  /**
   * Read tasks from disk (avoids in-memory inconsistency between dual module instances).
   */
  private async readTasksFromDisk(): Promise<ScheduledTask[]> {
    return readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
  }

  /**
   * Return all tasks for the current instance (reads from disk each time to ensure cross-instance consistency).
   */
  async getTasks(): Promise<ScheduledTask[]> {
    await this.ensureInit();
    const tasks = await this.readTasksFromDisk();
    // Sort by sortIndex; tasks without sortIndex fall back to createdAt
    tasks.sort((a, b) => (a.sortIndex ?? a.createdAt) - (b.sortIndex ?? b.createdAt));
    return tasks;
  }

  /**
   * Return the count of unread tasks (reads from disk each time).
   */
  async getUnreadCount(): Promise<number> {
    await this.ensureInit();
    const tasks = await this.readTasksFromDisk();
    return tasks.filter(t => t.unread).length;
  }

  /**
   * Add a task.
   */
  async addTask(task: ScheduledTask): Promise<ScheduledTask> {
    await this.ensureInit();
    const fullTask: ScheduledTask = { ...task };

    // Append directly to disk (avoids dual-instance issues); locked read-modify-write.
    await mutateJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, [], (allTasks) => [...allTasks, fullTask]);

    // Sync in-memory state (the server.mjs instance needs to set a timer)
    this.tasks.push(fullTask);
    if (!fullTask.paused && !fullTask.completed) {
      this.scheduleTask(fullTask);
    }
    return fullTask;
  }

  /**
   * Update a task (read → modify → write to disk; avoids dual-instance issues).
   */
  async updateTask(id: string, fields: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    await this.ensureInit();
    // Locked read-modify-write so a concurrent fireTask/saveToDisk can't interleave
    // and revert this update (or vice-versa).
    const task = await withFileLock(SCHEDULED_TASKS_FILE, async () => {
      const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
      const idx = allTasks.findIndex(t => t.id === id);
      if (idx === -1) return null;
      const updated = { ...allTasks[idx], ...fields };
      allTasks[idx] = updated;
      await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
      return updated;
    });
    if (!task) return null;

    // Sync in-memory state (the server.mjs instance needs to rebuild its timer)
    const memIdx = this.tasks.findIndex(t => t.id === id);
    if (memIdx !== -1) {
      this.tasks[memIdx] = task;
      this.clearTimer(id);
      if (!task.paused && !task.completed) {
        this.scheduleTask(task);
      }
    }
    return task;
  }

  /**
   * Delete a task (read → modify → write to disk; avoids dual-instance issues).
   */
  async deleteTask(id: string): Promise<boolean> {
    await this.ensureInit();
    const removed = await withFileLock(SCHEDULED_TASKS_FILE, async () => {
      const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
      const idx = allTasks.findIndex(t => t.id === id);
      if (idx === -1) return false;
      allTasks.splice(idx, 1);
      await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
      return true;
    });
    if (!removed) return false;

    // Sync in-memory state
    const memIdx = this.tasks.findIndex(t => t.id === id);
    if (memIdx !== -1) {
      this.clearTimer(id);
      this.tasks.splice(memIdx, 1);
    }
    return true;
  }

  /**
   * Pause a task.
   */
  async pauseTask(id: string): Promise<ScheduledTask | null> {
    return this.updateTask(id, { paused: true });
  }

  /**
   * Resume a task.
   */
  async resumeTask(id: string): Promise<ScheduledTask | null> {
    // Read latest data from disk
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    const task = allTasks.find(t => t.id === id);
    if (!task) return null;

    // Recalculate nextFireTime
    const now = Date.now();
    let nextFireTime = task.nextFireTime;
    if (nextFireTime <= now) {
      if (task.type === 'interval' && task.intervalMinutes) {
        nextFireTime = now + task.intervalMinutes * 60000;
      } else if (task.type === 'cron' && task.cron) {
        nextFireTime = getNextCronTime(task.cron);
      } else {
        // once type already expired; schedule 1 minute from now
        nextFireTime = now + 60000;
      }
    }

    // Reset the failure counter so a resumed task (incl. one auto-paused by the
    // circuit breaker) gets a fresh set of attempts instead of re-tripping on the
    // first failure.
    return this.updateTask(id, { paused: false, nextFireTime, consecutiveFailures: 0 });
  }

  /**
   * Manually trigger a task (runs in the background; returns immediately; does not affect the existing schedule).
   * Skips paused / activeRange checks and sends the message directly.
   */
  async triggerTask(id: string): Promise<void> {
    await this.ensureInit();
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    const task = allTasks.find(t => t.id === id);
    if (!task) return;

    // Sync to in-memory state
    const memIdx = this.tasks.findIndex(t => t.id === id);
    if (memIdx !== -1) {
      this.tasks[memIdx] = task;
    } else {
      this.tasks.push(task);
    }

    // Execute in the background to avoid blocking the HTTP request (sendChatMessage can take minutes)
    this.fireTaskManual(id).catch(err => {
      console.error(`[ScheduledTask] Manual trigger failed for ${id}:`, err);
    });
  }

  /** Internal implementation for manual trigger; skips paused / activeRange checks. */
  private async fireTaskManual(id: string): Promise<void> {
    // Share the same in-flight Set as fireTask: if the task is mid-flight from a
    // cron tick, the manual trigger would otherwise start a second concurrent run
    // against the same session (the route's 409 guard is the second line of defense).
    if (this.firing.has(id)) {
      console.warn(`[ScheduledTask] Skipping manual trigger of ${id}: still in flight`);
      return;
    }

    const task = this.tasks.find(t => t.id === id);
    if (!task) return;

    console.log(`[ScheduledTask] Manual trigger ${id}: "${task.message}"`);

    this.firing.add(id);
    try {
      const success = await sendChatMessage(task);

      task.lastFiredAt = Date.now();
      task.lastResult = success ? 'success' : 'error';
      // Track the counter (a manual success clears the breaker) but never auto-pause on a
      // user-initiated trigger — only the scheduled path trips the circuit breaker.
      task.consecutiveFailures = success ? 0 : (task.consecutiveFailures ?? 0) + 1;
      task.unread = true;

      // Manual trigger does not change completed / nextFireTime; preserves the existing schedule
      await this.saveToDisk();

      if (this.onTaskFired) {
        this.onTaskFired(task);
      }
    } finally {
      this.firing.delete(id);
    }
  }

  /**
   * Mark a task as read.
   */
  async markRead(id: string): Promise<void> {
    await this.updateTask(id, { unread: false });
  }

  /**
   * Mark tasks as read by sessionId (called when user views a tab).
   */
  async markReadBySessionId(sessionId: string): Promise<void> {
    await this.ensureInit();
    await withFileLock(SCHEDULED_TASKS_FILE, async () => {
      const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
      let changed = false;
      for (const task of allTasks) {
        if (task.sessionId === sessionId && task.unread) {
          task.unread = false;
          changed = true;
        }
      }
      if (changed) await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
    });
  }

  /**
   * Mark all tasks as read (operates directly on disk; avoids dual-instance issues).
   */
  async markAllRead(): Promise<void> {
    await this.ensureInit();
    await withFileLock(SCHEDULED_TASKS_FILE, async () => {
      const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
      let changed = false;
      for (const task of allTasks) {
        if (task.unread) {
          task.unread = false;
          changed = true;
        }
      }
      if (changed) await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
    });
  }

  /**
   * Reorder tasks by writing sortIndex values based on the given id array order.
   */
  async reorderTasks(orderedIds: string[]): Promise<void> {
    await this.ensureInit();
    await withFileLock(SCHEDULED_TASKS_FILE, async () => {
      const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
      for (let i = 0; i < orderedIds.length; i++) {
        const task = allTasks.find(t => t.id === orderedIds[i]);
        if (task) task.sortIndex = i;
      }
      await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
    });
  }

  // ---- Internal ----

  /**
   * Schedule a task. If nextFireTime has already passed, recalculate the next fire time instead of firing immediately.
   * Returns true if a timer was set, or false if the task has expired and cannot be rescheduled (once type).
   */
  private scheduleTask(task: ScheduledTask): boolean {
    const now = Date.now();

    if (task.nextFireTime <= now) {
      // Expired: recalculate the next fire time
      if (task.type === 'interval' && task.intervalMinutes) {
        task.nextFireTime = now + task.intervalMinutes * 60000;
      } else if (task.type === 'cron' && task.cron) {
        task.nextFireTime = getNextCronTime(task.cron);
      } else {
        // once type has expired; mark as completed and do not schedule
        task.completed = true;
        return false;
      }
    }

    // Defensive: if a timer already exists for this task, clear it first.
    // Map.set would otherwise overwrite the reference and leak the prior timer
    // into Node's timer heap, where it would still fire and double-trigger fireTask.
    this.clearTimer(task.id);

    const delay = task.nextFireTime - now;
    const timer = setTimeout(() => {
      this.fireTask(task.id);
    }, delay);
    this.timers.set(task.id, timer);
    return true;
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) {
      clearTimeout(timer);
      this.timers.delete(id);
    }
  }

  /**
   * Check whether the current time falls within the active time range for an interval task.
   */
  private isInActiveRange(task: ScheduledTask): boolean {
    if (task.type !== 'interval' || !task.activeFrom || !task.activeTo) return true;
    const now = new Date();
    const [fh, fm] = task.activeFrom.split(':').map(Number);
    const [th, tm] = task.activeTo.split(':').map(Number);
    const current = now.getHours() * 60 + now.getMinutes();
    const from = fh * 60 + fm;
    const to = th * 60 + tm;
    // Support cross-midnight ranges such as 22:00 ~ 06:00
    if (from <= to) {
      return current >= from && current <= to;
    } else {
      return current >= from || current <= to;
    }
  }

  private async fireTask(id: string): Promise<void> {
    // Reentrancy guard: sendChatMessage can take minutes; without this, a manual
    // trigger overlapping with cron, an HMR-leaked timer, or any other re-entry
    // would start a second run against the same session and likely trip the engine's
    // burst rate limit (the route's 409 guard would also reject it, recorded as error).
    if (this.firing.has(id)) {
      console.warn(`[ScheduledTask] Skipping reentrant fire of ${id}: still in flight`);
      return;
    }

    const task = this.tasks.find(t => t.id === id);
    if (!task || task.paused) return;

    // Recurring task: if outside the active range, skip and schedule the next occurrence
    if (!this.isInActiveRange(task)) {
      console.log(`[ScheduledTask] Skipping task ${id}: outside active range ${task.activeFrom}-${task.activeTo}`);
      if (task.type === 'interval' && task.intervalMinutes) {
        task.nextFireTime = Date.now() + task.intervalMinutes * 60000;
        this.scheduleTask(task);
        await this.saveToDisk();
      }
      return;
    }

    console.log(`[ScheduledTask] Firing task ${id}: "${task.message}"`);

    this.firing.add(id);
    try {
      // Execute the send
      const success = await sendChatMessage(task);

      // Update state
      task.lastFiredAt = Date.now();
      task.lastResult = success ? 'success' : 'error';
      task.consecutiveFailures = success ? 0 : (task.consecutiveFailures ?? 0) + 1;
      task.unread = true;

      // Circuit breaker: stop a recurring task that keeps failing (e.g. persistent
      // rate-limit / route-down) instead of retrying forever. The jsonl-missing case
      // self-heals (fresh session), so this guards the *other* persistent failures.
      const tripped =
        !success && (task.consecutiveFailures ?? 0) >= MAX_CONSECUTIVE_FAILURES;

      if (task.type === 'once') {
        task.completed = true;
      } else if (tripped) {
        task.paused = true;
        this.clearTimer(id);
        console.warn(
          `[ScheduledTask] auto-paused task ${id} after ${task.consecutiveFailures} consecutive failures`,
        );
      } else if (task.type === 'interval' && task.intervalMinutes) {
        task.nextFireTime = Date.now() + task.intervalMinutes * 60000;
        this.scheduleTask(task);
      } else if (task.type === 'cron' && task.cron) {
        task.nextFireTime = getNextCronTime(task.cron);
        this.scheduleTask(task);
      }

      await this.saveToDisk();

      // Notify the frontend
      if (this.onTaskFired) {
        this.onTaskFired(task);
      }
    } finally {
      this.firing.delete(id);
    }
  }

  private async saveToDisk(): Promise<void> {
    try {
      // Single instance per data dir (enforced at startup): the in-memory set IS the whole
      // file. The lock serializes against updateTask/addTask/etc.
      await mutateJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, [], () => [...this.tasks]);
    } catch (error) {
      console.error('[ScheduledTaskManager] Failed to save:', error);
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
