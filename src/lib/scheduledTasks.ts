import { query } from '@anthropic-ai/claude-agent-sdk';
import { SCHEDULED_TASKS_FILE, readJsonFile, writeJsonFile } from './paths';
import { updateGlobalState, getSessionTitle } from './global-state';

// ============================================
// Types
// ============================================

export interface ScheduledTask {
  id: string;
  port: number;            // 创建时的实例端口，用于隔离 dev/prod
  cwd: string;
  tabId: string;
  sessionId: string;       // chat session id
  message: string;
  type: 'once' | 'interval' | 'cron';
  delayMinutes?: number;   // type=once
  intervalMinutes?: number; // type=interval
  activeFrom?: string;     // type=interval 活跃时间范围开始, "09:00"
  activeTo?: string;       // type=interval 活跃时间范围结束, "18:00"
  cron?: string;           // type=cron, e.g. "0 9 * * *"
  nextFireTime: number;    // timestamp ms
  paused: boolean;
  completed?: boolean;     // type=once 触发后
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
 * 计算 cron 表达式的下一个触发时间
 */
export function getNextCronTime(cronExpr: string, after: Date = new Date()): number {
  const parts = cronExpr.trim().split(/\s+/);
  if (parts.length !== 5) return after.getTime() + 60000; // fallback 1 min

  const minutes = parseCronField(parts[0], 0, 59);
  const hours = parseCronField(parts[1], 0, 23);
  const doms = parseCronField(parts[2], 1, 31);
  const months = parseCronField(parts[3], 1, 12);
  const dows = parseCronField(parts[4], 0, 6); // 0=Sunday

  // 从 after + 1min 开始逐分钟扫描，最多扫 366 天
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
// Send Chat Message (直接调用 SDK，不走 HTTP)
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

    // 标记 loading
    await updateGlobalState(task.cwd, task.sessionId, 'loading', undefined, task.message).catch(() => {});

    const response = query({
      prompt: task.message,
      options,
    });

    // 消费完整个流（等待完成）
    for await (const _message of response) {
      // 只需消费流，不需要处理
    }

    // 标记结束
    const title = await getSessionTitle(task.cwd, task.sessionId);
    await updateGlobalState(task.cwd, task.sessionId, 'unread', title);

    return true;
  } catch (error) {
    console.error(`[ScheduledTask] Failed to send message for task ${task.id}:`, error);
    // 标记结束
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
   * 获取当前端口（从显式 init 或环境变量推断）
   */
  private getPort(): number {
    if (this.port) return this.port;
    // 优先使用显式设置的 COCKPIT_PORT
    const envPort = parseInt(process.env.COCKPIT_PORT || '0', 10);
    if (envPort) { this.port = envPort; return this.port; }
    // 回退：用 COCKPIT_ENV 推断，与 server.mjs 同逻辑
    const isDev = process.env.COCKPIT_ENV === 'dev';
    this.port = isDev ? 3456 : 3457;
    return this.port;
  }

  /**
   * 确保已初始化（懒初始化，支持被 API route 的不同模块实例调用）
   */
  async ensureInit(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    const port = this.getPort();
    if (!port) return; // 无法确定端口，跳过
    this.initPromise = this.init(port);
    return this.initPromise;
  }

  /**
   * 初始化：加载磁盘任务，重建 timer
   */
  async init(port: number): Promise<void> {
    if (this.initialized) return;
    this.port = port;
    this.initialized = true;

    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    // 只加载当前实例端口的任务
    this.tasks = allTasks.filter(t => t.port === port);

    console.log(`[ScheduledTaskManager] Loaded ${this.tasks.length} tasks for port ${port}`);

    // 重建 timer
    for (const task of this.tasks) {
      if (!task.paused && !task.completed) {
        this.scheduleTask(task);
      }
    }
  }

  /**
   * 注册 task-fired 回调（用于 WS 广播）
   */
  setOnTaskFired(cb: TaskFiredCallback): void {
    this.onTaskFired = cb;
  }

  /**
   * 从磁盘读取当前端口的任务（解决模块双实例内存不一致问题）
   */
  private async readTasksFromDisk(): Promise<ScheduledTask[]> {
    const port = this.getPort();
    if (!port) return [];
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    return allTasks.filter(t => t.port === port);
  }

  /**
   * 获取当前实例的所有任务（每次从磁盘读取，确保跨实例一致性）
   */
  async getTasks(): Promise<ScheduledTask[]> {
    await this.ensureInit();
    const tasks = await this.readTasksFromDisk();
    // 按 sortIndex 排序（无 sortIndex 的按 createdAt 排到末尾）
    tasks.sort((a, b) => (a.sortIndex ?? a.createdAt) - (b.sortIndex ?? b.createdAt));
    return tasks;
  }

  /**
   * 获取未读任务数（每次从磁盘读取）
   */
  async getUnreadCount(): Promise<number> {
    await this.ensureInit();
    const tasks = await this.readTasksFromDisk();
    return tasks.filter(t => t.unread).length;
  }

  /**
   * 添加任务
   */
  async addTask(task: Omit<ScheduledTask, 'port'>): Promise<ScheduledTask> {
    await this.ensureInit();
    const fullTask: ScheduledTask = { ...task, port: this.getPort() };

    // 直接追加到磁盘（解决双实例问题）
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    allTasks.push(fullTask);
    await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);

    // 同步内存（server.mjs 实例需要建 timer）
    this.tasks.push(fullTask);
    if (!fullTask.paused && !fullTask.completed) {
      this.scheduleTask(fullTask);
    }
    return fullTask;
  }

  /**
   * 更新任务（磁盘读→改→写，解决双实例问题）
   */
  async updateTask(id: string, fields: Partial<ScheduledTask>): Promise<ScheduledTask | null> {
    await this.ensureInit();
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx === -1) return null;

    const task = { ...allTasks[idx], ...fields };
    allTasks[idx] = task;
    await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);

    // 同步内存（server.mjs 实例需要重建 timer）
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
   * 删除任务（磁盘读→改→写，解决双实例问题）
   */
  async deleteTask(id: string): Promise<boolean> {
    await this.ensureInit();
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    const idx = allTasks.findIndex(t => t.id === id);
    if (idx === -1) return false;

    allTasks.splice(idx, 1);
    await writeJsonFile(SCHEDULED_TASKS_FILE, allTasks);

    // 同步内存
    const memIdx = this.tasks.findIndex(t => t.id === id);
    if (memIdx !== -1) {
      this.clearTimer(id);
      this.tasks.splice(memIdx, 1);
    }
    return true;
  }

  /**
   * 暂停任务
   */
  async pauseTask(id: string): Promise<ScheduledTask | null> {
    return this.updateTask(id, { paused: true });
  }

  /**
   * 恢复任务
   */
  async resumeTask(id: string): Promise<ScheduledTask | null> {
    // 从磁盘读取最新数据
    const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
    const task = allTasks.find(t => t.id === id);
    if (!task) return null;

    // 重算 nextFireTime
    const now = Date.now();
    let nextFireTime = task.nextFireTime;
    if (nextFireTime <= now) {
      if (task.type === 'interval' && task.intervalMinutes) {
        nextFireTime = now + task.intervalMinutes * 60000;
      } else if (task.type === 'cron' && task.cron) {
        nextFireTime = getNextCronTime(task.cron);
      } else {
        // once 且已过期，设为 1 分钟后
        nextFireTime = now + 60000;
      }
    }

    return this.updateTask(id, { paused: false, nextFireTime });
  }

  /**
   * 标记任务已读
   */
  async markRead(id: string): Promise<void> {
    await this.updateTask(id, { unread: false });
  }

  /**
   * 标记所有已读（直接操作磁盘，解决双实例问题）
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
   * 重排任务顺序（按传入的 id 数组顺序写入 sortIndex）
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

  private scheduleTask(task: ScheduledTask): void {
    const now = Date.now();
    const delay = Math.max(task.nextFireTime - now, 1000); // 至少 1s

    const timer = setTimeout(() => {
      this.fireTask(task.id);
    }, delay);
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
   * 检查当前时间是否在 interval 任务的活跃时间范围内
   */
  private isInActiveRange(task: ScheduledTask): boolean {
    if (task.type !== 'interval' || !task.activeFrom || !task.activeTo) return true;
    const now = new Date();
    const [fh, fm] = task.activeFrom.split(':').map(Number);
    const [th, tm] = task.activeTo.split(':').map(Number);
    const current = now.getHours() * 60 + now.getMinutes();
    const from = fh * 60 + fm;
    const to = th * 60 + tm;
    // 支持跨午夜如 22:00 ~ 06:00
    if (from <= to) {
      return current >= from && current <= to;
    } else {
      return current >= from || current <= to;
    }
  }

  private async fireTask(id: string): Promise<void> {
    const task = this.tasks.find(t => t.id === id);
    if (!task || task.paused) return;

    // 周期任务：不在活跃时间范围内则跳过，直接安排下一次
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

    // 执行发送
    const success = await sendChatMessage(task);

    // 更新状态
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

    // 通知前端
    if (this.onTaskFired) {
      this.onTaskFired(task);
    }
  }

  private async saveToDisk(): Promise<void> {
    try {
      // 读取全部任务（包含其他端口的），合并后写回
      const allTasks = await readJsonFile<ScheduledTask[]>(SCHEDULED_TASKS_FILE, []);
      const otherTasks = allTasks.filter(t => t.port !== this.port);
      await writeJsonFile(SCHEDULED_TASKS_FILE, [...otherTasks, ...this.tasks]);
    } catch (error) {
      console.error('[ScheduledTaskManager] Failed to save:', error);
    }
  }
}

// 全局单例
export const scheduledTaskManager = new ScheduledTaskManager();
