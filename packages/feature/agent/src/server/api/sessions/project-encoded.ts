import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Effect } from 'effect';
import { CLAUDE_PROJECTS_DIR, CLAUDE2_PROJECTS_DIR, DEEPSEEK_PROJECTS_DIR, KIMI_PROJECTS_DIR, COCKPIT_PROJECTS_DIR, getBuiltinSessionsRoot, findCodexSessionPath } from '@cockpit/shared-utils';
import { dynamicHandler } from '@cockpit/effect-runtime/server';
import { AppError, ValidationError } from '@cockpit/effect-core';
import { generateTitle } from '../../sessionTitle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionInfo {
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
   * here: `/api/session-by-path` re-derives it, including the sdk-vs-builtin execution mode
   * this field deliberately does not carry, and Chat writes the answer into session.json.
   */
  engine?: 'claude' | 'claude2' | 'ollama' | 'codex' | 'kimi' | 'deepseek';
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
      // Extract summary (standard Claude Code CLI)
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
      const entry = JSON.parse(line) as { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } };
      if (entry.type !== 'response_item') continue;
      const payload = entry.payload;
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

      const text = payload.content
        ?.filter(c => c.type === 'input_text' && c.text)
        .map(c => c.text!)
        .join('') || '';

      // Skip system/developer messages
      if (!text || text.startsWith('<') || text.startsWith('#')) continue;
      userMessages.push(text);
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
    // Collect session files from all engine directories. Every store here holds
    // Claude-format transcripts, so one parser covers them all. DeepSeek and Kimi each
    // contribute TWO stores because their execution modes don't share one: SDK mode is
    // written by the Agent SDK under <engine>/projects, Built-in Agent mode by us under
    // <engine>-sessions.
    const claudeDir = path.join(CLAUDE_PROJECTS_DIR, encodedPath);
    const claude2Dir = path.join(CLAUDE2_PROJECTS_DIR, encodedPath);
    const ollamaDir = path.join(getBuiltinSessionsRoot('ollama'), encodedPath);
    const deepseekSdkDir = path.join(DEEPSEEK_PROJECTS_DIR, encodedPath);
    const deepseekBuiltinDir = path.join(getBuiltinSessionsRoot('deepseek'), encodedPath);
    const kimiSdkDir = path.join(KIMI_PROJECTS_DIR, encodedPath);
    const kimiBuiltinDir = path.join(getBuiltinSessionsRoot('kimi'), encodedPath);

    const allSessionFiles = [
      ...collectSessionFiles(claudeDir, 'claude'),
      ...collectSessionFiles(claude2Dir, 'claude2'),
      ...collectSessionFiles(ollamaDir, 'ollama'),
      ...collectSessionFiles(deepseekSdkDir, 'deepseek'),
      ...collectSessionFiles(deepseekBuiltinDir, 'deepseek'),
      ...collectSessionFiles(kimiSdkDir, 'kimi'),
      ...collectSessionFiles(kimiBuiltinDir, 'kimi'),
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
        const { aiTitle, summary, userMessages } = await parseSessionFile(sessionFile.path);

        // Filter out empty sessions with no user messages (only queue-operation)
        if (userMessages.length === 0) {
          continue;
        }

        // Get the first 5 and last 5 user messages
        let firstMessages: string[] = [];
        let lastMessages: string[] = [];

        if (userMessages.length <= 10) {
          // Total does not exceed 10 entries; put all in firstMessages
          firstMessages = userMessages.map(m => truncateMessage(m));
        } else {
          firstMessages = userMessages.slice(0, 5).map(m => truncateMessage(m));
          lastMessages = userMessages.slice(-5).map(m => truncateMessage(m));
        }

        const displayTitle = generateTitle(aiTitle, summary, userMessages);
        sessions.push({
          path: sessionFile.path,
          title: displayTitle,
          modifiedAt: sessionFile.modifiedAt.toISOString(),
          firstMessages,
          lastMessages,
          searchText: buildSearchText(displayTitle, userMessages),
          engine: sessionFile.engine,
        });
      } catch (error) {
        console.error(`Error parsing session file ${sessionFile.path}:`, error);
        // Skip files that fail to parse
      }
    }

    // Parse Codex sessions (resolved via cockpit session.json)
    for (const sessionId of getCodexSessionIds(encodedPath)) {
      // Skip if already found (e.g. session was also saved as Claude format)
      if (seen.has(`${sessionId}.jsonl`)) continue;

      try {
        const filePath = findCodexSessionPath(sessionId);
        if (!filePath || !fs.existsSync(filePath)) continue;
        const parseResult = await parseCodexSessionFile(filePath);
        if (parseResult.userMessages.length === 0) continue;

        const modifiedAt = getFileModifiedTime(filePath);
        const { userMessages } = parseResult;

        let firstMessages: string[] = [];
        let lastMessages: string[] = [];

        if (userMessages.length <= 10) {
          firstMessages = userMessages.map(m => truncateMessage(m));
        } else {
          firstMessages = userMessages.slice(0, 5).map(m => truncateMessage(m));
          lastMessages = userMessages.slice(-5).map(m => truncateMessage(m));
        }

        const displayTitle = generateTitle('', '', userMessages);
        sessions.push({
          path: filePath,
          title: displayTitle,
          modifiedAt: modifiedAt.toISOString(),
          firstMessages,
          lastMessages,
          searchText: buildSearchText(displayTitle, userMessages),
          engine: 'codex',
        });
      } catch (error) {
        console.error(`Error parsing codex session ${sessionId}:`, error);
      }
    }

    // Re-sort all sessions by modification time descending
    sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());
    return sessions;
}
