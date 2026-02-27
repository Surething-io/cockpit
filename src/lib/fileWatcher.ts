import { watch, readFileSync, statSync, type FSWatcher } from 'fs';
import { join, resolve, dirname } from 'path';

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
  /** throttle 定时器：首个事件到达后最多等 THROTTLE_MS 必须 flush */
  throttleTimer: ReturnType<typeof setTimeout> | null;
  /** cwd watcher 出错后的重建定时器，防止多次并发重建 */
  cwdRestartTimer: ReturnType<typeof setTimeout> | null;
}

/** Git 关键文件，变化意味着 git 操作（commit, checkout, merge 等） */
const GIT_WATCH_FILES = [
  '.git/HEAD',
  // 不监听 .git/index：git status 会刷新其 stat cache 导致反馈循环
  // commit/checkout/merge 等操作都会同时修改 HEAD 或 refs，无需靠 index 检测
  '.git/MERGE_HEAD',
  '.git/REBASE_HEAD',
];

/** Git 关键目录 */
const GIT_WATCH_DIRS = [
  '.git/refs',
];

const DEBOUNCE_MS = 500;
/** AI 编码等高频场景下，事件聚合的最大等待时间（throttle 上限） */
const THROTTLE_MS = 3000;

/**
 * 获取实际的 .git 目录路径
 * 普通仓库: cwd/.git (目录)
 * Worktree: cwd/.git 是文件，内容为 "gitdir: /path/to/main/.git/worktrees/xxx"
 */
function resolveGitDir(cwd: string): string {
  const dotGit = join(cwd, '.git');
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      return dotGit;
    }
    // .git 是文件（worktree）
    const content = readFileSync(dotGit, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (match) {
      return resolve(cwd, match[1]);
    }
  } catch {
    // .git 不存在
  }
  return dotGit; // fallback
}

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

    // 最后一个 listener 退出时，关闭所有 watcher 并清理定时器
    if (entry.listeners.size === 0) {
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      if (entry.throttleTimer) clearTimeout(entry.throttleTimer);
      if (entry.cwdRestartTimer) clearTimeout(entry.cwdRestartTimer);
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
      throttleTimer: null,
      cwdRestartTimer: null,
    };

    const pushEvent = (event: FileEvent) => {
      // 去重：同类型事件在同一个窗口内只保留一个
      if (!entry.pendingEvents.some(e => e.type === event.type)) {
        entry.pendingEvents.push(event);
      }
      // debounce：每次新事件重置，变更停止 500ms 后 flush（快速响应零星变更）
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        this.flush(entry);
      }, DEBOUNCE_MS);
      // throttle：首个事件启动，最多等 THROTTLE_MS 后强制 flush（高频变更时不会一直等待）
      if (!entry.throttleTimer) {
        entry.throttleTimer = setTimeout(() => {
          this.flush(entry);
        }, THROTTLE_MS);
      }
    };

    // ========== 监听 cwd（recursive）==========
    // macOS 原生支持 recursive，1 个 fd 监听整个目录树
    // 出错时（如系统 inotify 耗尽）自动重建，避免监听静默失效
    const startCwdWatcher = () => {
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
          // 从数组中移除失效的 watcher，释放引用
          const idx = entry.watchers.indexOf(cwdWatcher);
          if (idx !== -1) entry.watchers.splice(idx, 1);
          try { cwdWatcher.close(); } catch { /* already closed */ }
          // 仍有订阅者时，2 秒后重建（防止多次并发重建）
          if (entry.listeners.size > 0 && !entry.cwdRestartTimer) {
            entry.cwdRestartTimer = setTimeout(() => {
              entry.cwdRestartTimer = null;
              if (entry.listeners.size > 0) startCwdWatcher();
            }, 2000);
          }
        });
        entry.watchers.push(cwdWatcher);
      } catch (err) {
        console.error(`Failed to watch ${cwd}:`, err);
      }
    };
    startCwdWatcher();

    // ========== 监听 git 关键文件 ==========
    // 支持 worktree：.git 可能是文件而非目录
    const gitDir = resolveGitDir(cwd);
    for (const gitFile of GIT_WATCH_FILES) {
      const filename = gitFile.replace('.git/', '');
      try {
        const w = watch(join(gitDir, filename), () => {
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
    for (const gitDirName of GIT_WATCH_DIRS) {
      const dirName = gitDirName.replace('.git/', '');
      try {
        const w = watch(join(gitDir, dirName), { recursive: true }, () => {
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
    // 清理定时器，防止重复 flush
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    if (entry.throttleTimer) { clearTimeout(entry.throttleTimer); entry.throttleTimer = null; }

    if (entry.pendingEvents.length === 0) return;

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
