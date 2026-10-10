import { watch, readFileSync, statSync, existsSync, type FSWatcher } from 'fs';
import { join, resolve } from 'path';

export interface FileEvent {
  /** 'file' = regular file change, 'git' = .git directory change */
  type: 'file' | 'git';
}

export type FileChangeCallback = (events: FileEvent[]) => void;

interface WatcherEntry {
  watchers: FSWatcher[];
  listeners: Set<FileChangeCallback>;
  pendingEvents: FileEvent[];
  debounceTimer: ReturnType<typeof setTimeout> | null;
  /** Throttle timer: must flush within THROTTLE_MS after the first event arrives */
  throttleTimer: ReturnType<typeof setTimeout> | null;
  /** Rebuild timer after a cwd watcher error, prevents multiple concurrent rebuilds */
  cwdRestartTimer: ReturnType<typeof setTimeout> | null;
}

/** Key Git files whose changes indicate a git operation (commit, checkout, merge, etc.) */
const GIT_WATCH_FILES = [
  '.git/HEAD',
  // Do not watch .git/index: git status refreshes its stat cache, causing a feedback loop.
  // commit/checkout/merge all modify HEAD or refs simultaneously; index is not needed.
  '.git/MERGE_HEAD',
  '.git/REBASE_HEAD',
];

/** Key Git directories to watch */
const GIT_WATCH_DIRS = [
  '.git/refs',
];

const DEBOUNCE_MS = 500;
/** Maximum wait time for event aggregation in high-frequency scenarios like AI coding (throttle ceiling) */
const THROTTLE_MS = 3000;

/**
 * Resolve the actual .git directory path.
 * Normal repo: cwd/.git (directory).
 * Worktree: cwd/.git is a file containing "gitdir: /path/to/main/.git/worktrees/xxx".
 */
function resolveGitDir(cwd: string): string {
  const dotGit = join(cwd, '.git');
  try {
    const stat = statSync(dotGit);
    if (stat.isDirectory()) {
      return dotGit;
    }
    // .git is a file (worktree)
    const content = readFileSync(dotGit, 'utf-8').trim();
    const match = content.match(/^gitdir:\s*(.+)$/);
    if (match) {
      return resolve(cwd, match[1]);
    }
  } catch {
    // .git does not exist
  }
  return dotGit; // fallback
}

/**
 * Resolve the common .git directory that holds shared refs.
 * Normal repo: same as gitDir.
 * Worktree: gitDir/commondir points at the main repo's .git (usually "../..").
 * Branch refs live there, so a commit inside a worktree only rewrites
 * <commonDir>/refs/heads/<branch> — the worktree's own HEAD is a symref that
 * stays untouched. Watching only gitDir/refs therefore misses every commit.
 */
function resolveCommonDir(gitDir: string): string {
  try {
    const rel = readFileSync(join(gitDir, 'commondir'), 'utf-8').trim();
    if (rel) return resolve(gitDir, rel);
  } catch {
    // No commondir file: not a worktree
  }
  return gitDir;
}

class FileWatcherManager {
  private watchers = new Map<string, WatcherEntry>();

  /**
   * Subscribe to file change events for a given cwd.
   * @returns unsubscribe function
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

    // When the last listener is removed, close all watchers and clear timers
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
      // Deduplicate: keep at most one event of each type per window
      if (!entry.pendingEvents.some(e => e.type === event.type)) {
        entry.pendingEvents.push(event);
      }
      // Debounce: reset on each new event, flush 500ms after changes stop (responsive to sparse changes)
      if (entry.debounceTimer) clearTimeout(entry.debounceTimer);
      entry.debounceTimer = setTimeout(() => {
        this.flush(entry);
      }, DEBOUNCE_MS);
      // Throttle: start on the first event, force flush after THROTTLE_MS (prevents indefinite waiting during high-frequency changes)
      if (!entry.throttleTimer) {
        entry.throttleTimer = setTimeout(() => {
          this.flush(entry);
        }, THROTTLE_MS);
      }
    };

    // ========== Watch cwd (recursive) ==========
    // macOS natively supports recursive watching; one fd covers the entire directory tree.
    // On error (e.g. inotify exhaustion), rebuild automatically to prevent silent watch failure.
    const startCwdWatcher = () => {
      try {
        const cwdWatcher = watch(cwd, { recursive: true }, (_eventType, filename) => {
          if (!filename) return;
          if (filename.startsWith('.next/') || filename.startsWith('node_modules/')) return;
          // .git directory: only respond to key file changes (HEAD, refs); ignore high-frequency changes like index.
          // Leverage FSEvents reliability to compensate for single-file kqueue watchers invalidating after atomic renames.
          if (filename.startsWith('.git/')) {
            if (filename === '.git/HEAD' || filename.startsWith('.git/refs/')) {
              pushEvent({ type: 'git' });
            }
            return;
          }
          pushEvent({ type: 'file' });
        });
        cwdWatcher.on('error', (err) => {
          console.error(`File watcher error for ${cwd}:`, err);
          // Remove the stale watcher from the array to release the reference
          const idx = entry.watchers.indexOf(cwdWatcher);
          if (idx !== -1) entry.watchers.splice(idx, 1);
          try { cwdWatcher.close(); } catch { /* already closed */ }
          // If subscribers still exist, rebuild after 2s (prevents multiple concurrent rebuilds)
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

    // ========== Watch key Git files ==========
    // Support worktrees: .git may be a file rather than a directory.
    const gitDir = resolveGitDir(cwd);

    // kqueue binds to an inode; after git's atomic replace (write tmp + rename) the watcher expires.
    // Non-worktrees fall back to the FSEvents recursive watcher; worktree HEAD outside cwd has no fallback.
    // Therefore, close and rebuild the watcher after each event to bind the new inode.
    const watchGitFile = (filePath: string) => {
      try {
        const w = watch(filePath, () => {
          pushEvent({ type: 'git' });
          // Rebuild: close the current watcher, bind the new inode
          try { w.close(); } catch { /* ignore */ }
          const idx = entry.watchers.indexOf(w);
          if (idx !== -1) entry.watchers.splice(idx, 1);
          if (entry.listeners.size > 0) {
            setTimeout(() => watchGitFile(filePath), 50);
          }
        });
        w.on('error', () => {
          const idx = entry.watchers.indexOf(w);
          if (idx !== -1) entry.watchers.splice(idx, 1);
          // File may be temporarily absent (e.g. MERGE_HEAD); retry after a delay
          if (entry.listeners.size > 0 && existsSync(filePath)) {
            setTimeout(() => watchGitFile(filePath), 500);
          }
        });
        entry.watchers.push(w);
      } catch {
        // File does not exist; ignore
      }
    };

    for (const gitFile of GIT_WATCH_FILES) {
      const filename = gitFile.replace('.git/', '');
      watchGitFile(join(gitDir, filename));
    }

    // ========== Watch key Git directories ==========
    // refs are shared across worktrees, so they live in the common dir.
    const commonDir = resolveCommonDir(gitDir);
    for (const gitDirName of GIT_WATCH_DIRS) {
      const dirName = gitDirName.replace('.git/', '');
      try {
        const w = watch(join(commonDir, dirName), { recursive: true }, () => {
          pushEvent({ type: 'git' });
        });
        w.on('error', () => {
          // Directory may not exist; ignore
        });
        entry.watchers.push(w);
      } catch {
        // Directory does not exist; ignore
      }
    }

    return entry;
  }

  private flush(entry: WatcherEntry): void {
    // Clear timers to prevent duplicate flushes
    if (entry.debounceTimer) { clearTimeout(entry.debounceTimer); entry.debounceTimer = null; }
    if (entry.throttleTimer) { clearTimeout(entry.throttleTimer); entry.throttleTimer = null; }

    if (entry.pendingEvents.length === 0) return;

    const events = [...entry.pendingEvents];
    entry.pendingEvents = [];

    // Notify all listeners
    for (const callback of entry.listeners) {
      try {
        callback(events);
      } catch (err) {
        console.error('File watcher callback error:', err);
      }
    }
  }
}

// Global singletons — pinned to globalThis to survive both Next.js dev HMR
// reloads and the Next.js custom-server dual module load (server.mjs's Node
// ESM import vs the webpack bundler import inside `.next/server`). Without
// this, two managers would each spawn their own fs.watch handles per
// subscribed cwd, doubling inotify/kqueue load and broadcasting each file
// change twice. Pattern matches PgPoolManager / RedisManager / etc.
const g_watch = globalThis as unknown as {
  __cockpitFileWatcher?: FileWatcherManager;
};
export const fileWatcher = g_watch.__cockpitFileWatcher ?? (g_watch.__cockpitFileWatcher = new FileWatcherManager());
