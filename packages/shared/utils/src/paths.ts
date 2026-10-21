import { homedir } from 'os';
import { join, resolve } from 'path';
import { chmod, mkdir, readFile, rename, unlink, writeFile } from 'fs/promises';
import { randomUUID } from 'crypto';
import { existsSync, renameSync } from 'fs';
import { encodePath } from './encodePath';
import { expandHomePath } from './homePath';

// ============================================
// Directory Constants
// ============================================

export const HOME_DIR = homedir();
// Data root. Defaults to ~/.cockpit (dev/prod share it — reusing prod data is
// intentional). Set COCKPIT_HOME to isolate (e.g. ~/.cockpit-dev, a CI tmp dir).
// Everything below derives from this, so this is the only switch needed.
export const COCKPIT_DIR = process.env.COCKPIT_HOME
  ? resolve(expandHomePath(process.env.COCKPIT_HOME, HOME_DIR))
  : join(HOME_DIR, '.cockpit');
export const COCKPIT_PROJECTS_DIR = join(COCKPIT_DIR, 'projects');
export const GLOBAL_STATE_FILE = join(COCKPIT_DIR, 'state.json');
export const PINNED_SESSIONS_FILE = join(COCKPIT_DIR, 'pinned-sessions.json');
export const PUSH_SUBSCRIPTIONS_FILE = join(COCKPIT_DIR, 'push-subscriptions.json');
// Web Push VAPID key pair. Its own file, NOT settings.json — GET /api/settings ships
// settings to the browser, and the private key must stay on the server.
export const PUSH_VAPID_FILE = join(COCKPIT_DIR, 'push-vapid.json');
export const NOTE_FILE = join(COCKPIT_DIR, 'note.md');
export const SCHEDULED_TASKS_FILE = join(COCKPIT_DIR, 'scheduled-tasks.json');
export const SETTINGS_FILE = join(COCKPIT_DIR, 'settings.json');
export const SKILLS_FILE = join(COCKPIT_DIR, 'skills.json');
export const BOTS_FILE = join(COCKPIT_DIR, 'bot.json');
// Where Bots live under the user's data dir. `/bot` creates new ones here, and
// it is also where a built-in is copied to the first time the user opens it
// (see BUILTIN_BOTS_SRC_DIR below). Per-COCKPIT_HOME and user-owned, which is
// exactly what the install root is not.
export const BOTS_DIR = join(COCKPIT_DIR, 'bots');
// Global registry of HTML "mini-app" file paths, launched as console browser
// bubbles. Same shape/mechanics as skills.json (manual add/remove of absolute
// paths), but the enrichment reads each file's <title>/<meta> head.
export const HTML_APPS_FILE = join(COCKPIT_DIR, 'html.json');

// Built-in HTML apps shipped inside the package (/apps), served by
// /apps/builtin/<name>/. NOT derived from COCKPIT_DIR — this is the install
// root, so it moves with the installation (npm global dir vs repo checkout)
// and must never be persisted into user data such as html.json.
// server.mjs sets COCKPIT_ROOT; cwd is the dev fallback.
export const APPS_DIR = join(process.env.COCKPIT_ROOT || process.cwd(), 'apps');

// Builtin slash-command prompts shipped inside the package (/skills/<cmd>/SKILL.md).
// Same install-root resolution as APPS_DIR — and for the same reason: these files
// move with the installation and must never be confused with the user's own skill
// data under COCKPIT_DIR (~/.cockpit/skills, where resolved copies are written).
export const BUILTIN_SKILLS_SRC_DIR = join(process.env.COCKPIT_ROOT || process.cwd(), 'skills');

// Built-in Bots shipped inside the package (/bots/<name>/BOT.md). Same
// install-root resolution as APPS_DIR, and never persisted into bot.json.
//
// SRC is the operative word: this is the *seed*, not the directory a built-in
// runs from. The install root is root-owned under `npm i -g`, replaced wholesale
// on upgrade, and shared by every COCKPIT_HOME — so a Bot living here could
// neither be edited nor remember anything. The first time the user opens one it
// is copied into BOTS_DIR/<name>, and from then on that copy is the Bot (see
// builtinBots.ts). Nothing is ever written back here.
export const BUILTIN_BOTS_SRC_DIR = join(process.env.COCKPIT_ROOT || process.cwd(), 'bots');

export const CLAUDE_DIR = join(HOME_DIR, '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
// DeepSeek, Kimi and GLM each keep only a credential file here. Their transcripts live in
// the Built-in Agent stores (~/.cockpit/<engine>-sessions) — these directories also used to
// hold a `projects/` subtree written by the Claude Agent SDK, which no longer runs for these
// engines. Old subtrees are left on disk untouched rather than deleted; nothing reads them.
//
// The API key lives in its own credential file, intentionally NOT in settings.json — so it
// is never returned by GET /api/settings (which is sent to the browser). Read/written only
// via /api/<engine>/credentials.
export const DEEPSEEK_DIR = join(COCKPIT_DIR, 'deepseek');
export const DEEPSEEK_CREDENTIALS_FILE = join(DEEPSEEK_DIR, 'credentials.json');
// Note this is NOT ~/.kimi — that belongs to Moonshot's own CLI, which cockpit never drives.
export const KIMI_DIR = join(COCKPIT_DIR, 'kimi');
export const KIMI_CREDENTIALS_FILE = join(KIMI_DIR, 'credentials.json');
// GLM (Zhipu BigModel). The store is region-agnostic on purpose: open.bigmodel.cn and
// api.z.ai serve the same account, so switching region must not orphan existing sessions.
export const GLM_DIR = join(COCKPIT_DIR, 'glm');
export const GLM_CREDENTIALS_FILE = join(GLM_DIR, 'credentials.json');
// Ollama connection config (baseUrl + apiKey) lives in its own file, NOT in
// settings.json — the apiKey must never be returned by GET /api/settings (which
// ships to the browser). baseUrl and apiKey are kept together because a given
// server URL pairs with its own key. Read/written only via /api/ollama/config
// and the resolvers in ollamaEnv.ts.
export const OLLAMA_DIR = join(COCKPIT_DIR, 'ollama');
export const OLLAMA_CONFIG_FILE = join(OLLAMA_DIR, 'config.json');

/**
 * Files that hold credentials. writeJsonFile writes these owner-only (0600) and
 * tightenSecretFiles fixes ones an older version left world-readable. Register every
 * new credential file here (constraints/secret-files-owner-only.test.ts checks that each
 * *_CREDENTIALS_FILE is listed).
 */
export const SECRET_FILES: readonly string[] = [
  DEEPSEEK_CREDENTIALS_FILE,
  KIMI_CREDENTIALS_FILE,
  GLM_CREDENTIALS_FILE,
  OLLAMA_CONFIG_FILE,
  PUSH_VAPID_FILE,
];
const SECRET_FILE_SET = new Set(SECRET_FILES);
const OWNER_ONLY = 0o600;

/**
 * Make every existing secret file owner-only, without rewriting it. Run at startup:
 * writeJsonFile only tightens a file the next time it is written.
 */
export async function tightenSecretFiles(): Promise<void> {
  for (const file of SECRET_FILES) {
    await chmod(file, OWNER_ONLY).catch((err: NodeJS.ErrnoException) => {
      if (err.code !== 'ENOENT') console.warn(`[paths] could not restrict permissions of ${file}: ${err.message}`);
    });
  }
}

/** Mode of the data directory: it holds transcripts' derived copies (titles, prompts,
 *  replies, search corpus), so it is the boundary that keeps them owner-only. */
export const PRIVATE_DIR_MODE = 0o700;

/**
 * Make the data directory owner-only, then every credential file. Run at startup.
 *
 * Why the directory and not each file: everything Cockpit derives from a session
 * (state.json, the transcript index, the search corpus, …) lands under COCKPIT_DIR,
 * and a per-file rule has to be remembered by every new writer — the transcript
 * index shards were written 0644 for exactly that reason. With the directory 0700,
 * another local user cannot reach any file inside, whatever its own mode is.
 */
export async function tightenPrivateData(): Promise<void> {
  await chmod(COCKPIT_DIR, PRIVATE_DIR_MODE).catch((err: NodeJS.ErrnoException) => {
    if (err.code !== 'ENOENT') console.warn(`[paths] could not restrict permissions of ${COCKPIT_DIR}: ${err.message}`);
  });
  await tightenSecretFiles();
}

// ============================================
// Path Encoding
// ============================================

// Implementation lives in ./encodePath (imported at the top of this file) so
// browser bundles can use it without dragging in this module's node fs/os/path
// dependencies. Re-exported here so every existing server-side import site
// keeps working unchanged.
export { encodePath };

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
 * Get the quick-instructions config path for a project (chat input shortcuts).
 * Deliberately a separate file from services.json: that one is the Console
 * domain's, and folding an Agent-domain list into it would make either feature's
 * write clobber the other's data on a partial POST.
 */
export function getInstructionsConfigPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'instructions.json');
}

/**
 * Pre-rename location of the same file, back when the feature was called
 * "quick prompts". Reads fall back to it when the new file is absent; writes
 * never target it, so the old file is left intact for a version rollback.
 * Delete this once no install can still be carrying one.
 */
export function getLegacyPromptsConfigPath(cwd: string): string {
  return join(getCockpitProjectDir(cwd), 'prompts.json');
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
 * Get the global services config path (shared across all projects)
 */
export function getGlobalServicesConfigPath(): string {
  return join(COCKPIT_DIR, 'services.json');
}

/**
 * Get the global quick-instructions config path (shared across all projects)
 */
export function getGlobalInstructionsConfigPath(): string {
  return join(COCKPIT_DIR, 'instructions.json');
}

/**
 * Global output-styles library: named system-prompt appendices the chat
 * toolbar can switch on per session. Global only — there is no project scope.
 */
export function getGlobalOutputStylesConfigPath(): string {
  return join(COCKPIT_DIR, 'output-styles.json');
}

/** Pre-rename global location — see getLegacyPromptsConfigPath. */
export function getLegacyGlobalPromptsConfigPath(): string {
  return join(COCKPIT_DIR, 'prompts.json');
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
// Built-in Agent Session Paths (~/.cockpit/<engine>-sessions/<encoded-cwd>/... )
// Written by engines/builtinAgent — our own agent loop, one store per engine.
// ============================================

/** engine → store directory name. `ollama` keeps its historical name: renaming it
 *  would orphan every existing ollama transcript on disk. */
const BUILTIN_SESSION_DIRS: Record<string, string> = {
  ollama: 'ollama-sessions',
  deepseek: 'deepseek-sessions',
  kimi: 'kimi-sessions',
  glm: 'glm-sessions',
};

/** Store directory names, relative to the cockpit data dir. For callers that resolve the
 *  data dir themselves (e.g. the Effect CockpitConfig) instead of using COCKPIT_DIR. */
export const BUILTIN_SESSION_DIR_NAMES: readonly string[] = Object.values(BUILTIN_SESSION_DIRS);

/** Root of an engine's Built-in Agent transcript store. Throws for engines that
 *  have no built-in mode, so a typo fails loudly instead of writing to ~/.cockpit. */
export function getBuiltinSessionsRoot(engine: string): string {
  const dir = BUILTIN_SESSION_DIRS[engine];
  if (!dir) throw new Error(`No built-in agent session store for engine "${engine}"`);
  return join(COCKPIT_DIR, dir);
}

/** Every Built-in Agent store root — for readers that must probe all of them. */
export function getBuiltinSessionRoots(): string[] {
  return Object.values(BUILTIN_SESSION_DIRS).map((dir) => join(COCKPIT_DIR, dir));
}

export function getBuiltinSessionsDir(engine: string, cwd: string): string {
  return join(getBuiltinSessionsRoot(engine), encodePath(cwd));
}

export function getBuiltinSessionPath(engine: string, cwd: string, sessionId: string): string {
  return join(getBuiltinSessionsDir(engine, cwd), `${sessionId}.jsonl`);
}

/**
 * Get the Ollama sessions directory for a given cwd
 */
export function getOllamaSessionsDir(cwd: string): string {
  return getBuiltinSessionsDir('ollama', cwd);
}

/**
 * Get the Ollama session file path for a given cwd
 */
export function getOllamaSessionPath(cwd: string, sessionId: string): string {
  return getBuiltinSessionPath('ollama', cwd, sessionId);
}

/** DeepSeek's transcript store. */
export function getDeepseekBuiltinSessionPath(cwd: string, sessionId: string): string {
  return getBuiltinSessionPath('deepseek', cwd, sessionId);
}

/** Kimi's transcript store. */
export function getKimiBuiltinSessionPath(cwd: string, sessionId: string): string {
  return getBuiltinSessionPath('kimi', cwd, sessionId);
}

/** GLM's transcript store. */
export function getGlmBuiltinSessionPath(cwd: string, sessionId: string): string {
  return getBuiltinSessionPath('glm', cwd, sessionId);
}

export const CODEX_SESSIONS_DIR = join(HOME_DIR, '.codex', 'sessions');

const CODEX_THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i;

export function normalizeCodexSessionId(sessionIdOrPath: string): string {
  const match = sessionIdOrPath.match(CODEX_THREAD_ID_RE);
  return match?.[1] ?? sessionIdOrPath;
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
 * Read a JSON file; missing OR malformed both yield `defaultValue`.
 *
 * Safe only when the result is read and discarded. **If you write the result
 * back, use readJsonFileForUpdate instead** — collapsing "corrupt" into the
 * same answer as "absent" means one stray comma in a hand-edited registry
 * reads as empty, and the next write persists that emptiness. A registry the
 * user is invited to edit by hand (bot.json, skills.json) loses every entry
 * that way, with a success toast.
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
 * Read a JSON file that is about to be written back: absent → `defaultValue`,
 * **malformed → throws**. The distinction readJsonFile cannot make is exactly
 * the one a read-modify-write cycle needs, so the caller fails loudly instead
 * of replacing the user's file with the default.
 */
export async function readJsonFileForUpdate<T>(filePath: string, defaultValue: T): Promise<T> {
  let content: string;
  try {
    content = await readFile(filePath, 'utf-8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return defaultValue;
    throw err;
  }
  try {
    return JSON.parse(content) as T;
  } catch (err) {
    throw new Error(
      `${filePath} is not valid JSON, refusing to overwrite it: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

const isRenameBlocked = (err: unknown) => {
  const code = (err as NodeJS.ErrnoException)?.code;
  return code === 'EPERM' || code === 'EACCES' || code === 'EBUSY';
};

/**
 * rename() that rides out Windows sharing violations. A reader holding the target open
 * (even a plain readFileSync, for a few ms) makes the rename fail with EPERM / EACCES /
 * EBUSY. On Windows the rename is synchronous, so it can never overlap a synchronous read
 * in this process (the unlocked readers in projects / session search); a reader in
 * another process is ridden out with a short retry (~0.8s) before the caller gives up on
 * atomicity. Elsewhere this is a single async rename.
 */
async function renameOver(from: string, to: string): Promise<void> {
  if (process.platform !== 'win32') return rename(from, to);
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (err) {
      if (attempt >= 12 || !isRenameBlocked(err)) throw err;
      await new Promise((r) => setTimeout(r, Math.min(10 * (attempt + 1), 150)));
    }
  }
}

/**
 * Write a JSON file atomically: write a temp file beside it, then rename it over the
 * target. Any reader — including ones that skip withFileLock, or another process — sees
 * the old document or the new one, never a truncated one, and a crash mid-write leaves
 * the old file intact. (withFileLock still serializes read-modify-write cycles; this is
 * about torn reads and crashes. constraints/atomic-state-writes.test.ts pins both.)
 *
 * The rename gives the file a new inode. On macOS a fs.watch on the FILE is bound to the
 * old inode and goes quiet — watch the directory and filter by name instead (see
 * watchGlobalStateFile).
 *
 * Credentials (SECRET_FILES) are created owner-only; the temp file carries the mode
 * through the rename.
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureParentDir(filePath);
  const body = JSON.stringify(data, null, 2);
  const secret = SECRET_FILE_SET.has(filePath);
  const tmp = `${filePath}.${process.pid}.${randomUUID()}.tmp`; // same dir: rename stays atomic
  try {
    await writeFile(tmp, body, secret ? { encoding: 'utf-8', mode: OWNER_ONLY } : 'utf-8');
    if (secret) await chmod(tmp, OWNER_ONLY); // `mode` is filtered by the umask
    await renameOver(tmp, filePath);
  } catch (err) {
    await unlink(tmp).catch(() => {});
    // Windows refuses to rename over a file another process holds open; once the retries
    // in renameOver are spent, fall back to an in-place write rather than failing the save.
    if (!isRenameBlocked(err)) throw err;
    await writeFile(filePath, body, secret ? { encoding: 'utf-8', mode: OWNER_ONLY } : 'utf-8');
    if (secret) await chmod(filePath, OWNER_ONLY);
  }
}

// ============================================
// File Lock (serialize concurrent read-modify-write)
// ============================================

// Process-wide lock map — pinned to globalThis. paths.ts is imported from BOTH
// the server.mjs module realm (via wsServer / scheduledTasks, loaded by Node
// ESM) AND the Next.js bundler realm (via `@cockpit/shared-utils`, loaded by
// webpack). Without globalThis dedup, each realm would have its own
// `fileLocks` Map and withFileLock would silently fail to serialize
// cross-realm writes to the same JSON file (e.g. state.json being touched by
// /api/chat AND wsServer at once).
const g_fileLocks = globalThis as unknown as { __cockpitFileLocks?: Map<string, Promise<void>> };
const fileLocks = g_fileLocks.__cockpitFileLocks ?? (g_fileLocks.__cockpitFileLocks = new Map<string, Promise<void>>());

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

/**
 * Lock-serialized read-modify-write of a JSON file. The lock spans the WHOLE
 * read→mutate→write cycle so concurrent callers can't interleave and lose each
 * other's updates (writeJsonFile makes each write atomic, not the cycle).
 *
 * Do NOT call this (or writeJsonFile/withFileLock on the same path) from inside
 * an existing withFileLock(samePath) block — the lock is a same-path promise
 * chain and nesting deadlocks.
 */
export function mutateJsonFile<T>(
  filePath: string,
  defaultValue: T,
  mutate: (current: T) => T | Promise<T>,
): Promise<T> {
  return withFileLock(filePath, async () => {
    // ForUpdate, not readJsonFile: this helper's whole purpose is writing the
    // result back, so a parse failure must abort rather than persist the default.
    const current = await readJsonFileForUpdate<T>(filePath, defaultValue);
    const next = await mutate(current);
    await writeJsonFile(filePath, next);
    return next;
  });
}
