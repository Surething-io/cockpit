import { NextRequest } from 'next/server';
import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { CLAUDE_PROJECTS_DIR } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
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

    const projectPath = path.join(CLAUDE_PROJECTS_DIR, encodedPath);

    // Check if the directory exists
    if (!fs.existsSync(projectPath)) {
      return new Response(JSON.stringify({ error: 'Project not found' }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Read all .jsonl files (exclude subprocess files starting with agent-)
    const sessionFiles = fs.readdirSync(projectPath)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
      .map(file => ({
        name: file,
        path: path.join(projectPath, file),
        modifiedAt: getFileModifiedTime(path.join(projectPath, file)),
      }))
      // Sort by modification time descending
      .sort((a, b) => b.modifiedAt.getTime() - a.modifiedAt.getTime());

    const sessions: SessionInfo[] = [];

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
        });
      } catch (error) {
        console.error(`Error parsing session file ${sessionFile.path}:`, error);
        // Skip files that fail to parse
      }
    }

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
