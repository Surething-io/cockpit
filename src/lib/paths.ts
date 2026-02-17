import { homedir } from 'os';
import { join } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';

// ============================================
// Directory Constants
// ============================================

export const HOME_DIR = homedir();
export const COCKPIT_DIR = join(HOME_DIR, '.cockpit');
export const COCKPIT_PROJECTS_DIR = join(COCKPIT_DIR, 'projects');
export const GLOBAL_STATE_FILE = join(COCKPIT_DIR, 'state.json');
export const NOTE_FILE = join(COCKPIT_DIR, 'note.md');
export const CLAUDE_DIR = join(HOME_DIR, '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');

// ============================================
// Path Encoding
// ============================================

/**
 * Encode a path to a safe directory name
 * e.g., /Users/ka/Work -> -Users-ka-Work
 */
export function encodePath(path: string): string {
  return path.replace(/\//g, '-');
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
 * Get the browser-tabs.json path for a project
 */
export function getBrowserTabsPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'browser-tabs.json');
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
 * Get the terminal aliases file path
 */
export function getTerminalAliasesPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'terminal-aliases.json');
}

/**
 * Get the terminal tabs file path
 */
export function getTerminalTabsPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'terminal-tabs.json');
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
 * Write a JSON file, creating parent directories if needed
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
}
