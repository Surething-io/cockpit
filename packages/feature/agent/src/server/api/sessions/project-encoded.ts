import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Effect } from 'effect';
import { CLAUDE_PROJECTS_DIR, COCKPIT_PROJECTS_DIR, getBuiltinSessionsRoot, findCodexSessionPath, listCodexSessionsByEncodedPath, normalizeCodexSessionId } from '@cockpit/shared-utils';
import { dynamicHandler } from '@cockpit/effect-runtime/server';
import { AppError, ValidationError } from '@cockpit/effect-core';
import { generateTitle } from '../../sessionTitle';
import { CODEX_IMAGE_ONLY_TEXT, extractCodexUserContent } from '../session/codexTools';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionInfo {
  sessionId: string;
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
  /**
   * Untruncated, lowercased full-text corpus (title/summary + every user
   * message) for the search panel. Display fields above stay truncated+sampled
   * (50 chars, first 5 + last 5); matching reads this so long-message tails and
   * mid-conversation messages remain searchable.
   */
  searchText: string;
  /**
   * Which engine wrote this transcript, derived from the store it lives in. Display only
   * (the badge in the session lists) — reopening a session does NOT restore its engine from
   * here: `/api/session-by-path` re-derives it and Chat writes the answer into session.json.
   */
  engine?: 'claude' | 'ollama' | 'codex' | 'kimi' | 'deepseek' | 'glm';
}

interface SessionListCacheEntry {
  mtimeMs: number;
  size: number;
  session: SessionInfo;
}

interface SessionListCache {
  version: 2;
  entries: Record<string, SessionListCacheEntry>;
}

interface TranscriptLine {
  type?: string;
  summary?: string;
  aiTitle?: string;
  isMeta?: boolean;
  message?: {
    role?: string;
    content?: string | Array<{ type: string; text?: string }>;
  };
}

// Truncate a message to the specified length
function truncateMessage(msg: string, maxLength: number = 50): string {
  if (msg.length <= maxLength) return msg;
  return msg.slice(0, maxLength) + '...';
}

// Build the untruncated, lowercased search corpus: the display title (summary
// preferred) plus every user message in full. Keeps long-message tails and
// mid-conversation messages searchable despite the truncated/sampled display.
function buildSearchText(title: string, userMessages: string[]): string {
  return [title, ...userMessages].join('\n').toLowerCase();
}

function sessionListCachePath(encodedPath: string): string {
  return path.join(COCKPIT_PROJECTS_DIR, encodedPath, 'session-list-cache.json');
}

function readSessionListCache(encodedPath: string): SessionListCache {
  try {
    const raw = JSON.parse(fs.readFileSync(sessionListCachePath(encodedPath), 'utf-8')) as Partial<SessionListCache>;
    if (raw.version !== 2 || !raw.entries || typeof raw.entries !== 'object') {
      return { version: 2, entries: {} };
    }
    return { version: 2, entries: raw.entries as Record<string, SessionListCacheEntry> };
  } catch {
    return { version: 2, entries: {} };
  }
}

function writeSessionListCache(encodedPath: string, cache: SessionListCache): void {
  let tmp: string | null = null;
  try {
    const filePath = sessionListCachePath(encodedPath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    tmp = `${filePath}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(cache, null, 2), 'utf-8');
    fs.renameSync(tmp, filePath);
  } catch {
    if (tmp) {
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }
}

function cacheHit(cache: SessionListCache, filePath: string, stat: fs.Stats): SessionInfo | null {
  const entry = cache.entries[filePath];
  if (!entry) return null;
  if (entry.mtimeMs !== stat.mtimeMs || entry.size !== stat.size) return null;
  return entry.session;
}

function buildSessionInfo(
  filePath: string,
  sessionId: string,
  modifiedAt: Date,
  engine: SessionInfo['engine'],
  aiTitle: string,
  summary: string,
  userMessages: string[],
): SessionInfo | null {
  if (userMessages.length === 0) return null;

  const firstMessages = userMessages.length <= 10
    ? userMessages.map(m => truncateMessage(m))
    : userMessages.slice(0, 5).map(m => truncateMessage(m));
  const lastMessages = userMessages.length <= 10
    ? []
    : userMessages.slice(-5).map(m => truncateMessage(m));
  const displayTitle = generateTitle(aiTitle, summary, userMessages);

  return {
    sessionId,
    path: filePath,
    title: displayTitle,
    modifiedAt: modifiedAt.toISOString(),
    firstMessages,
    lastMessages,
    searchText: buildSearchText(displayTitle, userMessages),
    engine,
  };
}

function cacheSessionInfo(
  cache: SessionListCache,
  filePath: string,
  stat: fs.Stats,
  session: SessionInfo,
): void {
  cache.entries[filePath] = {
    mtimeMs: stat.mtimeMs,
    size: stat.size,
    session,
  };
}

// Extract user message content from a jsonl file
function extractUserMessageContent(line: TranscriptLine): string | null {
  // Skip non-user messages and metadata messages
  if (line.type !== 'user') return null;
  if (line.isMeta) return null;

  const content = line.message?.content;
  if (!content) return null;

  if (typeof content === 'string') {
    return content;
  }

  if (Array.isArray(content)) {
    const textBlocks = content.filter(b => b.type === 'text');
    if (textBlocks.length > 0) {
      return textBlocks.map(b => b.text || '').join(' ');
    }
  }

  return null;
}

// Parse a single session file
async function parseSessionFile(filePath: string): Promise<{ aiTitle: string; summary: string; userMessages: string[] }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let aiTitle = '';
  let summary = '';
  const userMessages: string[] = [];

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line) as TranscriptLine;

      // Extract aiTitle (cockpit/SDK runtime; stable single value, last wins)
      if (obj.type === 'ai-title' && obj.aiTitle) {
        aiTitle = obj.aiTitle;
      }
      // Extract summary (standard Claude transcript)
      if (obj.type === 'summary' && obj.summary) {
        summary = obj.summary;
      }

      // Extract user messages
      const msgContent = extractUserMessageContent(obj);
      if (msgContent) {
        userMessages.push(msgContent);
      }
    } catch {
      // Ignore parse errors
    }
  }

  return { aiTitle, summary, userMessages };
}

// Get the file modification time
function getFileModifiedTime(filePath: string): Date {
  const stats = fs.statSync(filePath);
  return stats.mtime;
}

// Collect .jsonl session files from a directory (exclude agent- subprocess files)
function collectSessionFiles(dir: string, engine?: SessionInfo['engine']): Array<{ name: string; path: string; modifiedAt: Date; engine?: SessionInfo['engine'] }> {
  if (!fs.existsSync(dir)) return [];
  try {
    return fs.readdirSync(dir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => ({
        name: file,
        path: path.join(dir, file),
        modifiedAt: getFileModifiedTime(path.join(dir, file)),
        engine,
      }));
  } catch {
    return [];
  }
}

// Read cockpit session.json to find codex session IDs. Codex is the only engine left
// that needs this indirection: its transcripts live outside the cwd-encoded layout
// (~/.codex/sessions/<date-dirs>/rollout-…jsonl), so the session.json engines map is the
// only way to learn which ids belong to this project. Every other engine is found by
// scanning its own project directory above.
function getCodexSessionIds(encodedPath: string): string[] {
  try {
    const sessionJsonPath = path.join(COCKPIT_PROJECTS_DIR, encodedPath, 'session.json');
    if (!fs.existsSync(sessionJsonPath)) return [];
    const content = fs.readFileSync(sessionJsonPath, 'utf-8');
    const state = JSON.parse(content) as {
      sessions?: string[];
      engines?: Record<string, string>;
    };
    if (!state.sessions || !state.engines) return [];

    return state.sessions.filter((sessionId) => state.engines![sessionId] === 'codex');
  } catch {
    return [];
  }
}

// Parse a Codex session file for title and user messages
async function parseCodexSessionFile(filePath: string): Promise<{ title: string; userMessages: string[] }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const userMessages: string[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string; image_url?: string }> } };
      if (entry.type !== 'response_item') continue;
      const payload = entry.payload;
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

      const { text, images } = extractCodexUserContent(payload.content);

      // Skip system/developer messages
      if (images.length === 0 && (!text || text.startsWith('<') || text.startsWith('#'))) continue;
      userMessages.push(text || CODEX_IMAGE_ONLY_TEXT);
    } catch { /* ignore */ }
  }

  return { title: '', userMessages };
}

export const GET = dynamicHandler<
  { encodedPath: string },
  AppError | ValidationError
>((_req, { encodedPath }) =>
  Effect.gen(function* () {
    if (!encodedPath) {
      return yield* Effect.fail(
        new ValidationError({ field: 'encodedPath', reason: 'missing' })
      );
    }
    const sessions = yield* Effect.tryPromise({
      try: () => loadSessions(encodedPath),
      catch: (cause) =>
        new AppError({ message: 'Failed to load project sessions', cause }),
    });
    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  })
);

async function loadSessions(encodedPath: string) {
  const cache = readSessionListCache(encodedPath);
  const livePaths = new Set<string>();

  // Collect session files from all engine directories. Every store here holds
  // Claude-format transcripts, so one parser covers them all. One store per engine —
  // ~/.cockpit/<engine>/projects is deliberately absent: those are transcripts from the
  // removed Claude Agent SDK mode of deepseek/kimi/glm, and no loop remains that can
  // resume them, so listing them would offer sessions that die on the first turn.
  const claudeDir = path.join(CLAUDE_PROJECTS_DIR, encodedPath);

  const allSessionFiles = [
    ...collectSessionFiles(claudeDir, 'claude'),
    ...(['ollama', 'deepseek', 'kimi', 'glm'] as const).flatMap((engine) =>
      collectSessionFiles(path.join(getBuiltinSessionsRoot(engine), encodedPath), engine)
    ),
  ];

  // Deduplicate by filename (same sessionId could theoretically appear in both)
  const seen = new Set<string>();
  const sessionFiles = allSessionFiles
    .filter(f => {
      if (seen.has(f.name)) return false;
      seen.add(f.name);
      return true;
    })
    // Sort by modification time descending
    .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

  const sessions: SessionInfo[] = [];

  // Parse Claude/Ollama session files (both use Claude-style transcript format)
  for (const sessionFile of sessionFiles) {
    try {
      livePaths.add(sessionFile.path);
      const stat = fs.statSync(sessionFile.path);
      const cached = cacheHit(cache, sessionFile.path, stat);
      if (cached) {
        sessions.push(cached);
        continue;
      }

      const { aiTitle, summary, userMessages } = await parseSessionFile(sessionFile.path);
      const session = buildSessionInfo(
        sessionFile.path,
        sessionFile.name.replace(/\.jsonl$/, ''),
        sessionFile.modifiedAt,
        sessionFile.engine,
        aiTitle,
        summary,
        userMessages,
      );
      if (!session) continue;
      cacheSessionInfo(cache, sessionFile.path, stat, session);
      sessions.push(session);
    } catch (error) {
      console.error(`Error parsing session file ${sessionFile.path}:`, error);
      // Skip files that fail to parse
    }
  }

  // Parse Codex sessions. Current Cockpit state is the fast path, and the
  // global index backfills sessions registered by another COCKPIT_HOME.
  const codexSessionPaths = new Map<string, { sessionId: string; path: string }>();
  for (const sessionId of getCodexSessionIds(encodedPath)) {
    const filePath = findCodexSessionPath(sessionId);
    if (filePath) {
      codexSessionPaths.set(filePath, {
        sessionId: normalizeCodexSessionId(sessionId),
        path: filePath,
      });
    }
  }
  for (const entry of listCodexSessionsByEncodedPath(encodedPath)) {
    codexSessionPaths.set(entry.path, { sessionId: entry.id, path: entry.path });
  }

  for (const { sessionId, path: filePath } of codexSessionPaths.values()) {
    // Skip if already found (e.g. session was also saved as Claude format)
    if (seen.has(`${sessionId}.jsonl`)) continue;

    try {
      if (!filePath || !fs.existsSync(filePath)) continue;
      livePaths.add(filePath);
      const stat = fs.statSync(filePath);
      const cached = cacheHit(cache, filePath, stat);
      if (cached) {
        sessions.push(cached);
        continue;
      }

      const parseResult = await parseCodexSessionFile(filePath);
      const modifiedAt = getFileModifiedTime(filePath);
      const { userMessages } = parseResult;
      const session = buildSessionInfo(
        filePath,
        sessionId,
        modifiedAt,
        'codex',
        '',
        '',
        userMessages,
      );
      if (!session) continue;
      cacheSessionInfo(cache, filePath, stat, session);
      sessions.push(session);
    } catch (error) {
      console.error(`Error parsing codex session ${sessionId}:`, error);
    }
  }

  for (const filePath of Object.keys(cache.entries)) {
    if (!livePaths.has(filePath)) delete cache.entries[filePath];
  }
  writeSessionListCache(encodedPath, cache);

  // Re-sort all sessions by modification time descending
  sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
  return sessions;
}
