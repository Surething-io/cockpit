import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile, rename } from 'fs/promises';
import { existsSync } from 'fs';

// ============================================
// Directory Constants
// ============================================

export const HOME_DIR = homedir();
export const COCKPIT_DIR = join(HOME_DIR, '.cockpit');
export const COCKPIT_PROJECTS_DIR = join(COCKPIT_DIR, 'projects');
export const GLOBAL_STATE_FILE = join(COCKPIT_DIR, 'state.json');
export const PINNED_SESSIONS_FILE = join(COCKPIT_DIR, 'pinned-sessions.json');
export const NOTE_FILE = join(COCKPIT_DIR, 'note.md');
export const SCHEDULED_TASKS_FILE = join(COCKPIT_DIR, 'scheduled-tasks.json');
export const REVIEW_DIR = join(COCKPIT_DIR, 'review');
export const CLAUDE_DIR = join(HOME_DIR, '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

// ============================================
// Path Encoding
// ============================================

/**
 * Encode a path to a safe directory name
 * Must match Claude CLI's encoding: replace both / and . with -
 * e.g., /Users/ka/Work -> -Users-ka-Work
 * e.g., /foo/bar.worktrees/baz -> -foo-bar-worktrees-baz
 */
export function encodePath(path: string): string {
  return path.replace(/[/.]/g, '-');
}

// ============================================
// Cockpit Project Paths (~/.cockpit/projects/<encoded-cwd>/...)
// ============================================

/**
 * Get the cockpit project directory for a given cwd
 */
export function getCockpitProjectDir(cwd: string): string {
  return join(COCKPIT_PROJECTS_DIR, encodePath(cwd));
}

/**
 * Get the session.json path for a project
 */
export function getSessionFilePath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'session.json');
}

/**
 * Get the recent-files.json path for a project
 */
export function getRecentFilesPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'recent-files.json');
}

/**
 * Get the expanded-paths.json path for a project
 */
export function getExpandedPathsPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'expanded-paths.json');
}

/**
 * Get the comments.json path for a project
 */
export function getCommentsFilePath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'comments.json');
}

/**
 * Get the services config path for a project
 */
export function getServicesConfigPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'services.json');
}

/**
 * Get the note.md path for a project
 */
export function getProjectNotePath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'note.md');
}

/**
 * Get the logs directory for a project
 */
export function getLogsDir(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'logs');
}

/**
 * Get the log file path for a specific service command
 */
export function getServiceLogPath(cwd: string, commandHash: string): string {
  return join(getLogsDir(cwd), `${commandHash}.log`);
}

/**
 * Get the terminal history file path for a project tab
 */
export function getTerminalHistoryPath(cwd: string, tabId: string): string {
  return join(getCockpitProjectDir(cwd), `terminal-history-${tabId}.jsonl`);
}

/**
 * Get the terminal output file path for a specific command
 * Long outputs (> 4KB) are stored in separate files to keep JSONL small
 */
export function getTerminalOutputPath(cwd: string, commandId: string): string {
  return join(getCockpitProjectDir(cwd), `terminal-output-${commandId}.txt`);
}

/**
 * Get the terminal environment variables file path
 */
export function getTerminalEnvPath(cwd: string, tabId?: string): string {
  const fileName = tabId ? `terminal-env-${tabId}.json` : 'terminal-env-global.json';
  return join(getCockpitProjectDir(cwd), fileName);
}

/**
 * Get the global terminal aliases file path (shared across all projects)
 */
export function getGlobalAliasesPath(): string {
  return join(COCKPIT_DIR, 'terminal-aliases.json');
}

/**
 * Get the project settings file path (UI preferences like layout mode, active view)
 */
export function getProjectSettingsPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'project-settings.json');
}

/**
 * Get the bubble order file path for a project tab (drag-sort persistence)
 */
export function getBubbleOrderPath(cwd: string, tabId: string): string {
  return join(getCockpitProjectDir(cwd), `terminal-bubble-order-${tabId}.json`);
}

/**
 * Get the review JSON file path
 */
export function getReviewFilePath(reviewId: string): string {
  return join(REVIEW_DIR, `${reviewId}.json`);
}

// ============================================
// Claude Project Paths (~/.claude/projects/<encoded-cwd>/...)
// ============================================

/**
 * Get the Claude project directory for a given cwd
 */
export function getClaudeProjectDir(cwd: string): string {
  return join(CLAUDE_PROJECTS_DIR, encodePath(cwd));
}

/**
 * Get the session file path in Claude's projects directory
 */
export function getClaudeSessionPath(cwd: string, sessionId: string): string {
  return join(getClaudeProjectDir(cwd), `${sessionId}.jsonl`);
}

// ============================================
// File Utilities
// ============================================

/**
 * Ensure a directory exists
 */
export async function ensureDir(dirPath: string): Promise<void> {
  if (!existsSync(dirPath)) {
    await mkdir(dirPath, { recursive: true });
  }
}

/**
 * Ensure the parent directory of a file exists
 */
export async function ensureParentDir(filePath: string): Promise<void> {
  const dir = join(filePath, '..');
  await ensureDir(dir);
}

/**
 * Read a JSON file, return default value if not exists or invalid
 */
export async function readJsonFile<T>(filePath: string, defaultValue: T): Promise<T> {
  try {
    const content = await readFile(filePath, 'utf-8');
    return JSON.parse(content) as T;
  } catch {
    return defaultValue;
  }
}

/**
 * Write a JSON file atomically: write to tmp file first, then rename.
 * Eliminates the truncate window where concurrent reads see empty data.
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureParentDir(filePath);
  const tmpPath = filePath + '.tmp';
  await writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf-8');
  await rename(tmpPath, filePath);
}

// ============================================
// File Lock (serialize concurrent read-modify-write)
// ============================================

const fileLocks = new Map<string, Promise<void>>();

/**
 * Serialize async operations on the same file path.
 * Ensures read-modify-write cycles don't interleave.
 */
export function withFileLock<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
  const prev = fileLocks.get(filePath) ?? Promise.resolve();
  const run = prev.then(fn);
  // Chain: next operation waits for this one; errors don't propagate to next waiter
  const chain = run.then(() => {}, () => {});
  fileLocks.set(filePath, chain);
  // Clean up when idle (no more pending operations)
  chain.then(() => {
    if (fileLocks.get(filePath) === chain) {
      fileLocks.delete(filePath);
    }
  });
  return run;
}
