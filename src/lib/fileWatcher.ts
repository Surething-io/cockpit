import { watch, type FSWatcher } from 'fs';
import { join } from 'path';

export interface FileEvent {
  /** 'file' = 普通文件变更, 'git' = .git 目录变更（意味着 git 操作） */
  type: 'file' | 'git';
}

export type FileChangeCallback = (events: FileEvent[]) => void;

interface WatcherEntry {
  watchers: FSWatcher[];
  listeners: Set<FileChangeCallback>;
  pendingEvents: FileEvent[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** 上次 flush 的时间戳，用于 cooldown 防止高频触发 */
  lastFlushTime: number;
}

/** Git 关键文件，变化意味着 git 操作（commit, checkout, merge 等） */
const GIT_WATCH_FILES = [
  '.git/HEAD',
  '.git/index',
  '.git/MERGE_HEAD',
  '.git/REBASE_HEAD',
];

/** Git 关键目录 */
const GIT_WATCH_DIRS = [
  '.git/refs',
];

const DEBOUNCE_MS = 500;
/** flush 后的冷却时间，防止 API 请求触发的文件变化形成循环 */
const COOLDOWN_MS = 1000;

class FileWatcherManager {
  private watchers = new Map<string, WatcherEntry>();

  /**
   * 订阅某个 cwd 的文件变更事件
   * @returns unsubscribe 函数
   */
  subscribe(cwd: string, callback: FileChangeCallback): () => void {
    let entry = this.watchers.get(cwd);

    if (!entry) {
      entry = this.createWatcher(cwd);
      this.watchers.set(cwd, entry);
    }

    entry.listeners.add(callback);

    return () => {
      this.unsubscribe(cwd, callback);
    };
  }

  private unsubscribe(cwd: string, callback: FileChangeCallback): void {
    const entry = this.watchers.get(cwd);
    if (!entry) return;

    entry.listeners.delete(callback);

    // 最后一个 listener 退出时，关闭所有 watcher
    if (entry.listeners.size === 0) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      for (const w of entry.watchers) {
        try { w.close(); } catch { /* ignore */ }
      }
      this.watchers.delete(cwd);
    }
  }

  private createWatcher(cwd: string): WatcherEntry {
    const entry: WatcherEntry = {
      watchers: [],
      listeners: new Set(),
      pendingEvents: [],
      debounceTimer: null,
      lastFlushTime: 0,
    };

    const pushEvent = (event: FileEvent) => {
      // cooldown：上次 flush 后 COOLDOWN_MS 内忽略新事件，防循环
      if (Date.now() - entry.lastFlushTime < COOLDOWN_MS) return;

      // 去重：同类型事件在同一个 debounce 窗口内只保留一个
      if (!entry.pendingEvents.some(e => e.type === event.type)) {
        entry.pendingEvents.push(event);
      }
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        this.flush(entry);
      }, DEBOUNCE_MS);
    };

    // ========== 监听 cwd（recursive）==========
    // macOS 原生支持 recursive，1 个 fd 监听整个目录树
    // 3 秒 cooldown 防止 API 请求 → 文件变化 → 再次推送 的循环
    try {
      const cwdWatcher = watch(cwd, { recursive: true }, (_eventType, filename) => {
        if (filename && (
          filename.startsWith('.next/') ||
          filename.startsWith('node_modules/') ||
          filename.startsWith('.git/')
        )) return;
        pushEvent({ type: 'file' });
      });
      cwdWatcher.on('error', (err) => {
        console.error(`File watcher error for ${cwd}:`, err);
      });
      entry.watchers.push(cwdWatcher);
    } catch (err) {
      console.error(`Failed to watch ${cwd}:`, err);
    }

    // ========== 监听 git 关键文件 ==========
    for (const gitFile of GIT_WATCH_FILES) {
      try {
        const w = watch(join(cwd, gitFile), () => {
          pushEvent({ type: 'git' });
        });
        w.on('error', () => {
          // 文件可能不存在（如 MERGE_HEAD），忽略
        });
        entry.watchers.push(w);
      } catch {
        // 文件不存在，忽略
      }
    }

    // ========== 监听 git 关键目录 ==========
    for (const gitDir of GIT_WATCH_DIRS) {
      try {
        const w = watch(join(cwd, gitDir), { recursive: true }, () => {
          pushEvent({ type: 'git' });
        });
        w.on('error', () => {
          // 目录可能不存在，忽略
        });
        entry.watchers.push(w);
      } catch {
        // 目录不存在，忽略
      }
    }

    return entry;
  }

  private flush(entry: WatcherEntry): void {
    if (entry.pendingEvents.length === 0) return;

    entry.lastFlushTime = Date.now();
    const events = [...entry.pendingEvents];
    entry.pendingEvents = [];

    // 通知所有 listener
    for (const callback of entry.listeners) {
      try {
        callback(events);
      } catch (err) {
        console.error('File watcher callback error:', err);
      }
    }
  }
}

// 全局单例
export const fileWatcher = new FileWatcherManager();
