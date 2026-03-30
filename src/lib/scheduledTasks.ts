import { query } from '@anthropic-ai/claude-agent-sdk';
import { SCHEDULED_TASKS_FILE, readJsonFile, writeJsonFile } from './paths';
import { updateGlobalState, getSessionTitle } from './global-state';

// ============================================
// Types
// ============================================

export interface ScheduledTask {
  id: string;
  port: number;            // instance port at creation time, used to isolate dev/prod
  cwd: string;
  tabId: string;
  sessionId: string;       // chat session id
  message: string;
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
  createdAt: number;
  sortIndex?: number;
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
// Send Chat Message (invokes SDK directly, bypasses HTTP)
// ============================================

async function sendChatMessage(task: ScheduledTask): Promise<boolean> {
  try {
    const options = {
      resume: task.sessionId,
      cwd: task.cwd,
      settingSources: ['user' as const, 'project' as const, 'local' as const],
      allowedTools: [
        'Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep',
        'WebFetch', 'WebSearch', 'Task', 'TodoWrite', 'mcp__*',
      ],
      permissionMode: 'bypassPermissions' as const,
      allowDangerouslySkipPermissions: true,
      betas: ['context-1m-2025-08-07' as const],
    };

    // Mark as loading
    await updateGlobalState(task.cwd, task.sessionId, 'loading', undefined, task.message).catch(() => {});

    // SDK may perform context compaction mid-stream, which ends the async iterable
    // without a final end_turn. Detect this and re-query with resume to continue.
    const MAX_COMPACTION_RETRIES = 1;

    for (let attempt = 0; attempt <= MAX_COMPACTION_RETRIES; attempt++) {
      let receivedResult = false;

      const response = query({
        // First attempt: send the actual message
        // Retry after compaction: send 'continue' to resume
        prompt: attempt === 0 ? task.message : 'continue',
        options,
      });

      for await (const message of response) {
        const msg = message as { type?: string };
        if (msg.type === 'result') {
          receivedResult = true;
        }
      }

      // Got result = task truly finished
      if (receivedResult) break;

      // Stream ended without result → likely compaction, re-query to continue
      console.log(`[ScheduledTask] Stream ended without result, resuming (attempt ${attempt + 1}/${MAX_COMPACTION_RETRIES})`);
    }

    // Mark as done
    const title = await getSessionTitle(task.cwd, task.sessionId);
    await updateGlobalState(task.cwd, task.sessionId, 'unread', title);

    return true;
  } catch (error) {
    console.error(`[ScheduledTask] Failed to send message for task ${task.id}:`, error);
    // Mark as done
    await updateGlobalState(task.cwd, task.sessionId, 'unread').catch(() => {});
    return false;
  }
}

// ============================================
// ScheduledTaskManager Singleton
// ============================================

type TaskFiredCallback = (task: ScheduledTask) => void;

class ScheduledTaskManager {
  private tasks: ScheduledTask[] = [];
  private timers = new Map<string, ReturnType<typeof setTimeout>>();
  private port: number = 0;
  private initialized = false;
  private initPromise: Promise<void> | null = null;
  private onTaskFired: TaskFiredCallback | null = null;

  /**
   * Return the current port (from explicit init or environment variables).
   */
  private getPort(): number {
    if (this.port) return this.port;
    // Prefer explicitly set COCKPIT_PORT
    const envPort = parseInt(process.env.COCKPIT_PORT || '0', 10);
    if (envPort) { this.port = envPort; return this.port; }
    // Fallback: infer from COCKPIT_ENV, matching server.mjs logic
    const isDev = process.env.COCKPIT_ENV === 'dev';
    this.port = isDev ? 3456 : 3457;
    return this.port;
  }

  /**
   * Ensure the manager is initialized (lazy init; supports calls from different module instances in API routes).
   */
  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    const port = this.getPort();
    if (!port) return; // Cannot determine port; skip
    this.initPromise = this.init(port);
    return this.initPromise;
  }

  /**
   * Initialize: load tasks from disk and rebuild timers.
   */
  async init(port: number): Promise<void> {
    if (this.initialized) return;
    this.port = port;
    this.initialized = true;

    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    // Load only tasks belonging to the current instance's port
    this.tasks = allTasks.filter(t => t.port === port);

    console.log(`[ScheduledTaskManager] Loaded ${this.tasks.length} tasks for port ${port}`);

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
   * Read tasks for the current port from disk (avoids in-memory inconsistency between dual module instances).
   */
  private async readTasksFromDisk(): Promise<ScheduledTask[]> {
    const port = this.getPort();
    if (!port) return [];
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    return allTasks.filter(t => t.port === port);
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
  async addTask(task: Omit<ScheduledTask, 'port'>): Promise<ScheduledTask> {
    await this.ensureInit();
    const fullTask: ScheduledTask = { ...task, port: this.getPort() };

    // Append directly to disk (avoids dual-instance issues)
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    allTasks.push(fullTask);
    await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);

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
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx === -1) return null;

    const task = { ...allTasks[idx], ...fields };
    allTasks[idx] = task;
    await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);

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
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx === -1) return false;

    allTasks.splice(idx, 1);
    await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);

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

    return this.updateTask(id, { paused: false, nextFireTime });
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
    const task = this.tasks.find(t => t.id === id);
    if (!task) return;

    console.log(`[ScheduledTask] Manual trigger ${id}: "${task.message}"`);
    const success = await sendChatMessage(task);

    task.lastFiredAt = Date.now();
    task.lastResult = success ? 'success' : 'error';
    task.unread = true;

    // Manual trigger does not change completed / nextFireTime; preserves the existing schedule
    await this.saveToDisk();

    if (this.onTaskFired) {
      this.onTaskFired(task);
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
    const port = this.getPort();
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    let changed = false;
    for (const task of allTasks) {
      if (task.port === port && task.sessionId === sessionId && task.unread) {
        task.unread = false;
        changed = true;
      }
    }
    if (changed) await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
  }

  /**
   * Mark all tasks as read (operates directly on disk; avoids dual-instance issues).
   */
  async markAllRead(): Promise<void> {
    await this.ensureInit();
    const port = this.getPort();
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    let changed = false;
    for (const task of allTasks) {
      if (task.port === port && task.unread) {
        task.unread = false;
        changed = true;
      }
    }
    if (changed) await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
  }

  /**
   * Reorder tasks by writing sortIndex values based on the given id array order.
   */
  async reorderTasks(orderedIds: string[]): Promise<void> {
    await this.ensureInit();
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    for (let i = 0; i < orderedIds.length; i++) {
      const task = allTasks.find(t => t.id === orderedIds[i]);
      if (task) task.sortIndex = i;
    }
    await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);
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

    // Execute the send
    const success = await sendChatMessage(task);

    // Update state
    task.lastFiredAt = Date.now();
    task.lastResult = success ? 'success' : 'error';
    task.unread = true;

    if (task.type === 'once') {
      task.completed = true;
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
  }

  private async saveToDisk(): Promise<void> {
    try {
      // Read all tasks (including other ports), merge, then write back
      const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
      const otherTasks = allTasks.filter(t => t.port !== this.port);
      await writeJsonFile(SCHEDULED_TASKS_FILE, [...otherTasks, ...this.tasks]);
    } catch (error) {
      console.error('[ScheduledTaskManager] Failed to save:', error);
    }
  }
}

// Global singleton
export const scheduledTaskManager = new ScheduledTaskManager();
