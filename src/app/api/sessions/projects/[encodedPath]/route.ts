import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CLAUDE_PROJECTS_DIR, CLAUDE2_PROJECTS_DIR, COCKPIT_DIR, COCKPIT_PROJECTS_DIR, findCodexSessionPath, findKimiSessionPath } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
  engine?: 'claude' | 'claude2' | 'ollama' | 'codex' | 'kimi';
}

interface TranscriptLine {
  type?: string;
  summary?: string;
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

// Filter command tags and extract plain text content
function filterCommandTags(text: string): string {
  // Extract the content of <command-args> (the user's actual input)
  const argsMatch = text.match(/<command-args>([^<]*)<\/command-args>/);
  if (argsMatch && argsMatch[1].trim()) {
    return argsMatch[1].trim();
  }
  // If there are no args or args is empty, extract the command name (e.g. /qa)
  const nameMatch = text.match(/<command-name>([^<]*)<\/command-name>/);
  if (nameMatch && nameMatch[1].trim()) {
    return nameMatch[1].trim();
  }
  // Remove all command and system tags
  let filtered = text.replace(/<command-message>[^<]*<\/command-message>/g, '');
  filtered = filtered.replace(/<command-name>[^<]*<\/command-name>/g, '');
  filtered = filtered.replace(/<command-args>[^<]*<\/command-args>/g, '');
  filtered = filtered.replace(/<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g, '');
  filtered = filtered.replace(/<local-command-caveat>[\s\S]*?<\/local-command-caveat>/g, '');
  // Remove extra whitespace
  return filtered.trim();
}

// Generate a title: prefer summary; otherwise iterate userMessages for the first valid content
// If the first entry is a bare command (e.g. /qa), append the next valid content
function generateTitle(summary: string, userMessages: string[]): string {
  if (summary) return summary;

  let commandName = '';
  for (const msg of userMessages) {
    const filtered = filterCommandTags(msg);
    if (!filtered) continue;

    // If it is a bare command (starts with /), record it and keep looking
    if (filtered.startsWith('/') && !commandName) {
      commandName = filtered;
      continue;
    }

    // Found actual content (no truncation, preserve full content)
    if (commandName) {
      // Append command name and actual content
      return `${commandName} ${filtered}`;
    }
    return filtered;
  }

  // If there is only a command with no subsequent content
  if (commandName) return commandName;
  return 'Untitled Session';
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
async function parseSessionFile(filePath: string): Promise<{ title: string; userMessages: string[] }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({
    input: fileStream,
    crlfDelay: Infinity,
  });

  let title = '';
  const userMessages: string[] = [];

  for await (const line of rl) {
    try {
      const obj = JSON.parse(line) as TranscriptLine;

      // Extract title (summary)
      if (obj.type === 'summary' && obj.summary) {
        title = obj.summary;
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

  return { title, userMessages };
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

// Read cockpit session.json to find codex/kimi session IDs
function getCodexKimiSessionIds(encodedPath: string): Array<{ sessionId: string; engine: 'codex' | 'kimi' }> {
  try {
    const sessionJsonPath = path.join(COCKPIT_PROJECTS_DIR, encodedPath, 'session.json');
    if (!fs.existsSync(sessionJsonPath)) return [];
    const content = fs.readFileSync(sessionJsonPath, 'utf-8');
    const state = JSON.parse(content) as {
      sessions?: string[];
      engines?: Record<string, string>;
    };
    if (!state.sessions || !state.engines) return [];

    const results: Array<{ sessionId: string; engine: 'codex' | 'kimi' }> = [];
    for (const sessionId of state.sessions) {
      const engine = state.engines[sessionId];
      if (engine === 'codex' || engine === 'kimi') {
        results.push({ sessionId, engine });
      }
    }
    return results;
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

// Parse a Kimi session file for title and user messages
async function parseKimiSessionFile(filePath: string): Promise<{ title: string; userMessages: string[] }> {
  const fileStream = fs.createReadStream(filePath);
  const rl = readline.createInterface({ input: fileStream, crlfDelay: Infinity });

  const userMessages: string[] = [];

  for await (const line of rl) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line) as { role?: string; content?: string | Array<{ type?: string; text?: string }> };
      if (entry.role !== 'user') continue;

      const text = typeof entry.content === 'string'
        ? entry.content
        : Array.isArray(entry.content)
          ? entry.content.filter(c => (c.type === 'input_text' || c.type === 'text') && c.text).map(c => c.text!).join('')
          : '';

      // Skip system-injected messages
      if (!text || text.startsWith('<system') || text.startsWith('<environment') || text.startsWith('# AGENTS.md') || text.startsWith('<permissions')) continue;
      userMessages.push(text);
    } catch { /* ignore */ }
  }

  return { title: '', userMessages };
}

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ encodedPath: string }> }
) {
  try {
    const { encodedPath } = await params;

    if (!encodedPath) {
      return new Response(JSON.stringify({ error: 'Missing encodedPath' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Collect session files from all engine directories
    const claudeDir = path.join(CLAUDE_PROJECTS_DIR, encodedPath);
    const claude2Dir = path.join(CLAUDE2_PROJECTS_DIR, encodedPath);
    const ollamaDir = path.join(COCKPIT_DIR, 'ollama-sessions', encodedPath);

    const allSessionFiles = [
      ...collectSessionFiles(claudeDir, 'claude'),
      ...collectSessionFiles(claude2Dir, 'claude2'),
      ...collectSessionFiles(ollamaDir, 'ollama'),
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
        const { title, userMessages } = await parseSessionFile(sessionFile.path);

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

        sessions.push({
          path: sessionFile.path,
          title: generateTitle(title, userMessages),
          modifiedAt: sessionFile.modifiedAt.toISOString(),
          firstMessages,
          lastMessages,
          engine: sessionFile.engine,
        });
      } catch (error) {
        console.error(`Error parsing session file ${sessionFile.path}:`, error);
        // Skip files that fail to parse
      }
    }

    // Parse Codex/Kimi sessions (resolved via cockpit session.json)
    const engineSessions = getCodexKimiSessionIds(encodedPath);
    for (const { sessionId, engine } of engineSessions) {
      // Skip if already found (e.g. session was also saved as Claude format)
      if (seen.has(`${sessionId}.jsonl`)) continue;

      try {
        let filePath: string | null = null;
        let parseResult: { title: string; userMessages: string[] } | null = null;

        if (engine === 'codex') {
          filePath = findCodexSessionPath(sessionId);
          if (filePath && fs.existsSync(filePath)) {
            parseResult = await parseCodexSessionFile(filePath);
          }
        } else if (engine === 'kimi') {
          filePath = findKimiSessionPath(sessionId);
          if (filePath && fs.existsSync(filePath)) {
            parseResult = await parseKimiSessionFile(filePath);
          }
        }

        if (!filePath || !parseResult) continue;
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

        sessions.push({
          path: filePath,
          title: generateTitle('', userMessages),
          modifiedAt: modifiedAt.toISOString(),
          firstMessages,
          lastMessages,
          engine,
        });
      } catch (error) {
        console.error(`Error parsing ${engine} session ${sessionId}:`, error);
      }
    }

    // Re-sort all sessions by modification time descending
    sessions.sort((a, b) => new Date(b.modifiedAt).getTime() - new Date(a.modifiedAt).getTime());

    return new Response(JSON.stringify(sessions), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Project sessions API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
