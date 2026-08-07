import { homedir } from 'os';
import { dirname, join, resolve } from 'path';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { closeSync, existsSync, mkdirSync, openSync, readSync, realpathSync, renameSync, statSync, unlinkSync, writeFileSync, readdirSync, readFileSync } from 'fs';
import { execSync } from 'child_process';

// ============================================
// Directory Constants
// ============================================

export const HOME_DIR = homedir();
// Data root. Defaults to ~/.cockpit (dev/prod share it — reusing prod data is
// intentional). Set COCKPIT_HOME to isolate (e.g. ~/.cockpit-dev, a CI tmp dir).
// Everything below derives from this, so this is the only switch needed.
export const COCKPIT_DIR = process.env.COCKPIT_HOME
  ? resolve(process.env.COCKPIT_HOME.replace(/^~(?=$|\/)/, HOME_DIR))
  : join(HOME_DIR, '.cockpit');
export const COCKPIT_PROJECTS_DIR = join(COCKPIT_DIR, 'projects');
export const GLOBAL_STATE_FILE = join(COCKPIT_DIR, 'state.json');
export const PINNED_SESSIONS_FILE = join(COCKPIT_DIR, 'pinned-sessions.json');
export const PUSH_SUBSCRIPTIONS_FILE = join(COCKPIT_DIR, 'push-subscriptions.json');
export const NOTE_FILE = join(COCKPIT_DIR, 'note.md');
export const SCHEDULED_TASKS_FILE = join(COCKPIT_DIR, 'scheduled-tasks.json');
export const SETTINGS_FILE = join(COCKPIT_DIR, 'settings.json');
export const SKILLS_FILE = join(COCKPIT_DIR, 'skills.json');
export const CODEX_SESSION_INDEX_FILE = join(COCKPIT_DIR, 'codex-session-index.json');
// Global registry of HTML "mini-app" file paths, launched as console browser
// bubbles. Same shape/mechanics as skills.json (manual add/remove of absolute
// paths), but the enrichment reads each file's <title>/<meta> head.
export const HTML_APPS_FILE = join(COCKPIT_DIR, 'html.json');
export const REVIEW_DIR = join(COCKPIT_DIR, 'review');
export const REVIEW_SIGNAL_FILE = join(REVIEW_DIR, '_signal');

/**
 * Write to the signal file to notify ReviewWatcher of a comment change.
 * Synchronous write ensures fs.watch can detect the change.
 */
export function notifyReviewChange(): void {
  try {
    if (!existsSync(REVIEW_DIR)) mkdirSync(REVIEW_DIR, { recursive: true });
    writeFileSync(REVIEW_SIGNAL_FILE, Date.now().toString());
  } catch { /* ignore */ }
}
export const CLAUDE_DIR = join(HOME_DIR, '.claude');
export const CLAUDE_PROJECTS_DIR = join(CLAUDE_DIR, 'projects');
export const CLAUDE2_DIR = join(HOME_DIR, '.claude2');
export const CLAUDE2_PROJECTS_DIR = join(CLAUDE2_DIR, 'projects');
// DeepSeek uses the Claude Agent SDK with CLAUDE_CONFIG_DIR pointed here
// to keep its credentials/sessions isolated from the user's real ~/.claude
export const DEEPSEEK_DIR = join(COCKPIT_DIR, 'deepseek');
export const DEEPSEEK_PROJECTS_DIR = join(DEEPSEEK_DIR, 'projects');
// DeepSeek API key lives in its own credential file, intentionally NOT in
// settings.json — so it is never returned by GET /api/settings (which is sent
// to the browser). Read/written only via /api/deepseek/credentials.
export const DEEPSEEK_CREDENTIALS_FILE = join(DEEPSEEK_DIR, 'credentials.json');
// Kimi mirrors DeepSeek exactly: Claude Agent SDK against an Anthropic-compatible
// endpoint, with CLAUDE_CONFIG_DIR pointed here. Note this is NOT ~/.kimi — that
// belongs to Moonshot's own CLI, which cockpit no longer drives.
export const KIMI_DIR = join(COCKPIT_DIR, 'kimi');
export const KIMI_PROJECTS_DIR = join(KIMI_DIR, 'projects');
export const KIMI_CREDENTIALS_FILE = join(KIMI_DIR, 'credentials.json');
// GLM (Zhipu BigModel) — same shape again. Note the store is region-agnostic on
// purpose: open.bigmodel.cn and api.z.ai serve the same account, so switching
// region must not orphan existing sessions.
export const GLM_DIR = join(COCKPIT_DIR, 'glm');
export const GLM_PROJECTS_DIR = join(GLM_DIR, 'projects');
export const GLM_CREDENTIALS_FILE = join(GLM_DIR, 'credentials.json');
// Ollama connection config (baseUrl + apiKey) lives in its own file, NOT in
// settings.json — the apiKey must never be returned by GET /api/settings (which
// ships to the browser). baseUrl and apiKey are kept together because a given
// server URL pairs with its own key. Read/written only via /api/ollama/config
// and the resolvers in ollamaEnv.ts.
export const OLLAMA_DIR = join(COCKPIT_DIR, 'ollama');
export const OLLAMA_CONFIG_FILE = join(OLLAMA_DIR, 'config.json');

// ============================================
// Path Encoding
// ============================================

/**
 * Encode a path to a safe directory name
 * Must match Claude CLI's encoding: replace both / and . with -
 * e.g., /Users/you/Work -> -Users-you-Work
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
 * Get the quick-prompts config path for a project (chat input quick prompts).
 * Deliberately a separate file from services.json: that one is the Console
 * domain's, and folding an Agent-domain list into it would make either feature's
 * write clobber the other's data on a partial POST.
 */
export function getPromptsConfigPath(cwd: string): string {
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
 * Get the global quick-prompts config path (shared across all projects)
 */
export function getGlobalPromptsConfigPath(): string {
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
// Claude2 Project Paths (~/.claude2/projects/<encoded-cwd>/...)
// ============================================

/**
 * Get the Claude2 project directory for a given cwd
 */
export function getClaude2ProjectDir(cwd: string): string {
  return join(CLAUDE2_PROJECTS_DIR, encodePath(cwd));
}

/**
 * Get the session file path in Claude2's projects directory
 */
export function getClaude2SessionPath(cwd: string, sessionId: string): string {
  return join(getClaude2ProjectDir(cwd), `${sessionId}.jsonl`);
}

// ============================================
// DeepSeek Project Paths (~/.cockpit/deepseek/projects/<encoded-cwd>/...)
// Sessions written by Claude Agent SDK with CLAUDE_CONFIG_DIR=DEEPSEEK_DIR
// ============================================

/**
 * Get the DeepSeek project directory for a given cwd
 */
export function getDeepseekProjectDir(cwd: string): string {
  return join(DEEPSEEK_PROJECTS_DIR, encodePath(cwd));
}

/**
 * Get the session file path in DeepSeek's projects directory
 */
export function getDeepseekSessionPath(cwd: string, sessionId: string): string {
  return join(getDeepseekProjectDir(cwd), `${sessionId}.jsonl`);
}

// ============================================
// Kimi Project Paths (~/.cockpit/kimi/projects/<encoded-cwd>/...)
// Same layout as DeepSeek: written by the Claude Agent SDK with
// CLAUDE_CONFIG_DIR=KIMI_DIR.
// ============================================

export function getKimiProjectDir(cwd: string): string {
  return join(KIMI_PROJECTS_DIR, encodePath(cwd));
}

export function getKimiSessionPath(cwd: string, sessionId: string): string {
  return join(getKimiProjectDir(cwd), `${sessionId}.jsonl`);
}

// ============================================
// GLM Project Paths (~/.cockpit/glm/projects/<encoded-cwd>/...)
// ============================================

export function getGlmProjectDir(cwd: string): string {
  return join(GLM_PROJECTS_DIR, encodePath(cwd));
}

export function getGlmSessionPath(cwd: string, sessionId: string): string {
  return join(getGlmProjectDir(cwd), `${sessionId}.jsonl`);
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

/**
 * Get the DeepSeek Built-in Agent session file path (mode: 'builtin'). Distinct from
 * getDeepseekSessionPath, which is the Claude Agent SDK store under ~/.cockpit/deepseek/projects.
 */
export function getDeepseekBuiltinSessionPath(cwd: string, sessionId: string): string {
  return getBuiltinSessionPath('deepseek', cwd, sessionId);
}

/**
 * Get the Kimi Built-in Agent session file path (mode: 'builtin'). Distinct from
 * getKimiSessionPath, which is the Claude Agent SDK store under ~/.cockpit/kimi/projects.
 */
export function getKimiBuiltinSessionPath(cwd: string, sessionId: string): string {
  return getBuiltinSessionPath('kimi', cwd, sessionId);
}

/**
 * Get the GLM Built-in Agent session file path (mode: 'builtin'). Distinct from
 * getGlmSessionPath, which is the Claude Agent SDK store under ~/.cockpit/glm/projects.
 */
export function getGlmBuiltinSessionPath(cwd: string, sessionId: string): string {
  return getBuiltinSessionPath('glm', cwd, sessionId);
}

export const CODEX_SESSIONS_DIR = join(HOME_DIR, '.codex', 'sessions');

const CODEX_THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})(?:\.jsonl)?$/i;

export function normalizeCodexSessionId(sessionIdOrPath: string): string {
  const match = sessionIdOrPath.match(CODEX_THREAD_ID_RE);
  return match?.[1] ?? sessionIdOrPath;
}

export interface CodexSessionIndexEntry {
  id: string;
  path: string;
  cwd: string;
  cwdRealpath: string;
  modifiedAt: number;
  size: number;
  /** Set when this rollout is a sub-agent codex spawned, not a session the user started. */
  parentThreadId?: string;
  agentRole?: string;
  agentNickname?: string;
}

// Bumped 1 → 2 when sub-agent fields were added. readCodexIndex discards the whole
// file on a version mismatch, which is the ONLY thing that re-parses already-indexed
// rollouts: refreshCodexSessionIndex short-circuits on a cache hit and only refreshes
// mtime/size, so without this bump every previously seen sub-agent would keep its
// stale (unflagged) entry and go on polluting the session list forever.
const CODEX_INDEX_VERSION = 2;

interface CodexSessionIndexFile {
  version: number;
  updatedAt: number;
  files: Record<string, CodexSessionIndexEntry>;
}

const emptyCodexIndex = (): CodexSessionIndexFile => ({
  version: CODEX_INDEX_VERSION,
  updatedAt: 0,
  files: {},
});

function safeRealpath(p: string): string {
  try {
    return realpathSync(p);
  } catch {
    return resolve(p);
  }
}

function readCodexIndex(): CodexSessionIndexFile {
  try {
    const raw = JSON.parse(readFileSync(CODEX_SESSION_INDEX_FILE, 'utf-8')) as Partial<CodexSessionIndexFile>;
    if (raw.version !== CODEX_INDEX_VERSION || !raw.files || typeof raw.files !== 'object') return emptyCodexIndex();
    return {
      version: CODEX_INDEX_VERSION,
      updatedAt: raw.updatedAt || 0,
      files: raw.files as Record<string, CodexSessionIndexEntry>,
    };
  } catch {
    return emptyCodexIndex();
  }
}

function writeCodexIndex(index: CodexSessionIndexFile): void {
  let tmp: string | null = null;
  try {
    mkdirSync(dirname(CODEX_SESSION_INDEX_FILE), { recursive: true });
    tmp = `${CODEX_SESSION_INDEX_FILE}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    writeFileSync(tmp, JSON.stringify(index, null, 2), 'utf-8');
    renameSync(tmp, CODEX_SESSION_INDEX_FILE);
  } catch {
    if (tmp) {
      try { unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

function listCodexSessionFiles(): string[] {
  if (!existsSync(CODEX_SESSIONS_DIR)) return [];
  const out: string[] = [];
  const stack = [CODEX_SESSIONS_DIR];
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) stack.push(full);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) out.push(full);
    }
  }
  return out;
}

function readFirstLine(filePath: string, maxBytes = 1024 * 1024): string | null {
  let fd: number | null = null;
  try {
    fd = openSync(filePath, 'r');
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < maxBytes) {
      const buf = Buffer.alloc(Math.min(64 * 1024, maxBytes - total));
      const n = readSync(fd, buf, 0, buf.length, total);
      if (n <= 0) break;
      const slice = buf.subarray(0, n);
      const nl = slice.indexOf(10);
      if (nl >= 0) {
        chunks.push(slice.subarray(0, nl));
        return Buffer.concat(chunks).toString('utf-8');
      }
      chunks.push(slice);
      total += n;
    }
    return chunks.length ? Buffer.concat(chunks).toString('utf-8') : null;
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try { closeSync(fd); } catch { /* ignore */ }
    }
  }
}

function parseCodexSessionMeta(filePath: string): Omit<CodexSessionIndexEntry, 'path' | 'modifiedAt' | 'size'> | null {
  const line = readFirstLine(filePath);
  if (!line) return null;
  try {
    const entry = JSON.parse(line) as {
      type?: string;
      payload?: {
        id?: string;
        cwd?: string;
        // Present only on a sub-agent rollout (codex `spawn_agent`). Such a file is a
        // normal rollout in every other respect, so this is the only way to tell one
        // from a session the user actually started.
        parent_thread_id?: string;
        thread_source?: string;
        agent_role?: string;
        agent_nickname?: string;
      };
    };
    const id = entry.payload?.id;
    const cwd = entry.payload?.cwd;
    if (entry.type !== 'session_meta' || !id || !cwd) return null;
    const p = entry.payload!;
    const isSubagent = p.thread_source === 'subagent' || !!p.parent_thread_id;
    return {
      id,
      cwd,
      cwdRealpath: safeRealpath(cwd),
      ...(isSubagent
        ? {
            parentThreadId: p.parent_thread_id || '',
            ...(p.agent_role ? { agentRole: p.agent_role } : {}),
            ...(p.agent_nickname ? { agentNickname: p.agent_nickname } : {}),
          }
        : {}),
    };
  } catch {
    return null;
  }
}

export function refreshCodexSessionIndex(): CodexSessionIndexFile {
  const index = readCodexIndex();
  const files = listCodexSessionFiles();
  const existing = new Set(files);

  for (const filePath of Object.keys(index.files)) {
    if (!existing.has(filePath)) delete index.files[filePath];
  }

  for (const filePath of files) {
    let st: ReturnType<typeof statSync>;
    try {
      st = statSync(filePath);
    } catch {
      delete index.files[filePath];
      continue;
    }

    const cached = index.files[filePath];
    if (cached) {
      cached.modifiedAt = st.mtimeMs;
      cached.size = st.size;
      continue;
    }

    const meta = parseCodexSessionMeta(filePath);
    if (!meta) continue;
    index.files[filePath] = {
      ...meta,
      path: filePath,
      modifiedAt: st.mtimeMs,
      size: st.size,
    };
  }

  index.updatedAt = Date.now();
  writeCodexIndex(index);
  return index;
}

/**
 * True for a rollout codex wrote for a sub-agent it spawned. Tested on presence, not
 * truthiness: `parentThreadId` is `''` when a rollout is flagged `thread_source:
 * "subagent"` without naming its parent.
 */
export function isCodexSubagentEntry(entry: CodexSessionIndexEntry): boolean {
  return entry.parentThreadId !== undefined;
}

/**
 * Sessions the user started. Sub-agent rollouts are deliberately excluded: they sit in
 * the same directory with the same cwd as their parent, so they would otherwise show up
 * as top-level sessions titled with whatever prompt spawned them. Their content is
 * reachable from the parent's Task bubble (drill-in), and codex cannot resume a closed
 * sub-agent anyway.
 *
 * They stay IN the index — findCodexSessionPath reads it directly, and the drill-in
 * depends on being able to locate a sub-agent by id.
 */
export function listCodexSessions(): CodexSessionIndexEntry[] {
  const index = refreshCodexSessionIndex();
  return Object.values(index.files)
    .filter((entry) => !isCodexSubagentEntry(entry))
    .sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Every indexed rollout, sub-agents included. For lookups, not for listing. */
export function listAllCodexSessions(): CodexSessionIndexEntry[] {
  const index = refreshCodexSessionIndex();
  return Object.values(index.files).sort((a, b) => b.modifiedAt - a.modifiedAt);
}

/** Look up an indexed rollout by codex thread id (sub-agents included). */
export function findCodexSessionEntry(threadId: string): CodexSessionIndexEntry | null {
  const normalized = normalizeCodexSessionId(threadId);
  const cached = Object.values(readCodexIndex().files).find((e) => e.id === normalized);
  if (cached && existsSync(cached.path)) return cached;
  return Object.values(refreshCodexSessionIndex().files).find((e) => e.id === normalized) ?? null;
}

export function listCodexSessionsByEncodedPath(encodedPath: string): CodexSessionIndexEntry[] {
  return listCodexSessions().filter(
    (entry) => encodePath(entry.cwd) === encodedPath || encodePath(entry.cwdRealpath) === encodedPath
  );
}

/**
 * Find a Codex session file by thread_id.
 * Codex stores sessions at ~/.codex/sessions/YYYY/MM/DD/rollout-<timestamp>-<thread_id>.jsonl.
 */
export function findCodexSessionPath(threadId: string): string | null {
  const normalizedThreadId = normalizeCodexSessionId(threadId);
  const cached = Object.values(readCodexIndex().files).find((entry) => entry.id === normalizedThreadId);
  if (cached && existsSync(cached.path)) return cached.path;

  if (!existsSync(CODEX_SESSIONS_DIR)) return null;
  try {
    const result = execSync(
      `find ${JSON.stringify(CODEX_SESSIONS_DIR)} -name "*${normalizedThreadId}.jsonl" -type f 2>/dev/null`,
      { encoding: 'utf8', timeout: 3000 }
    ).trim();
    if (result) return result.split('\n')[0];
  } catch { /* ignore */ }
  return null;
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
 * Write a JSON file directly.
 * Single-process Node app + withFileLock serializes writers,
 * so no need for atomic rename (which breaks fs.watch on macOS).
 */
export async function writeJsonFile<T>(filePath: string, data: T): Promise<void> {
  await ensureParentDir(filePath);
  await writeFile(filePath, JSON.stringify(data, null, 2), 'utf-8');
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
 * other's updates (writeJsonFile is non-atomic by design — see above).
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
    const current = await readJsonFile<T>(filePath, defaultValue);
    const next = await mutate(current);
    await writeJsonFile(filePath, next);
    return next;
  });
}
