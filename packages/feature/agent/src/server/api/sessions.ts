import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { Effect } from 'effect';
import { CLAUDE_PROJECTS_DIR } from '@cockpit/shared-utils';
import { handler } from '@cockpit/effect-runtime/server';
import { AppError } from '@cockpit/effect-core';
import { generateTitle } from '../sessionTitle';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
}

interface ProjectGroup {
  name: string;
  fullPath: string;
  sessions: SessionInfo[];
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

export const GET = handler(() =>
  Effect.gen(function* () {
    const projectGroups = yield* Effect.tryPromise({
      try: () => loadProjectGroups(),
      catch: (cause) =>
        new AppError({ message: 'Failed to load sessions', cause }),
    });
    return new Response(JSON.stringify(projectGroups), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  })
);

async function loadProjectGroups(): Promise<ProjectGroup[]> {
    const projectsDir = CLAUDE_PROJECTS_DIR;

    if (!fs.existsSync(projectsDir)) {
      return [];
    }

    // Read all project directories
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    const projectGroups: ProjectGroup[] = [];

    for (const projectDirName of projectDirs) {
      const projectPath = path.join(projectsDir, projectDirName);

      // Decode project name (last path component)
      // e.g. -Users-you-Work-my-project -> my-project
      const pathParts = projectDirName.split('-').filter(Boolean);
      const projectName = pathParts[pathParts.length - 1] || projectDirName;

      // Decode the full path
      // e.g. -Users-you-Work-my-project -> /Users/you/Work/my-project
      const fullPath = '/' + projectDirName.slice(1).replace(/-/g, '/');

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

          sessions.push({
            path: sessionFile.path,
            title: generateTitle(aiTitle, summary, userMessages),
            modifiedAt: sessionFile.modifiedAt.toISOString(),
            firstMessages,
            lastMessages,
          });
        } catch (error) {
          console.error(`Error parsing session file ${sessionFile.path}:`, error);
          // Skip files that fail to parse
        }
      }

      if (sessions.length > 0) {
        projectGroups.push({
          name: projectName,
          fullPath,
          sessions,
        });
      }
    }

    // Sort alphabetically by project name
    projectGroups.sort((a, b) => a.name.localeCompare(b.name));
    return projectGroups;
}
