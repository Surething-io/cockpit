import { GLOBAL_STATE_FILE, readJsonFile, writeJsonFile, withFileLock, getClaudeSessionPath } from './paths';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';

export type SessionStatus = 'normal' | 'loading' | 'unread';

interface GlobalSession {
  cwd: string;
  sessionId: string;
  lastActive: number;
  status: SessionStatus;
  title?: string;
  lastUserMessage?: string;
  engine?: 'claude' | 'codex' | 'ollama';
}

interface GlobalState {
  sessions: GlobalSession[];
}

const MAX_SESSIONS = 15;
const MAX_TEXT_LEN = 50; // max character count for title / lastUserMessage

/** Truncate by Unicode characters, appending an ellipsis if over the limit */
function truncate(s: string | undefined): string | undefined {
  if (!s) return s;
  const chars = [...s]; // expand to code-point array; each emoji/CJK char counts as 1
  return chars.length <= MAX_TEXT_LEN ? s : chars.slice(0, MAX_TEXT_LEN).join('') + '…';
}

/**
 * Update global session state.
 * Uses withFileLock to serialize concurrent read-modify-write operations,
 * preventing data loss due to race conditions when multiple tasks fire simultaneously.
 */
export async function updateGlobalState(
  cwd: string,
  sessionId: string,
  status: SessionStatus,
  title?: string,
  lastUserMessage?: string
): Promise<void> {
  // Guard: skip non-existent paths (avoids writing with a wrongly decoded cwd)
  if (!existsSync(cwd)) {
    return;
  }

  return withFileLock(GLOBAL_STATE_FILE, async () => {
    const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

    // Migrate legacy format: isLoading → status
    for (const s of state.sessions) {
      if (!s.status) {
        const legacy = s as GlobalSession & { isLoading?: boolean };
        s.status = legacy.isLoading ? 'loading' : 'normal';
        delete legacy.isLoading;
      }
    }

    // Check if the session already exists
    const existingIndex = state.sessions.findIndex(
      s => s.cwd === cwd && s.sessionId === sessionId
    );

    // Retain existing fields when no new value is provided
    const existing = existingIndex >= 0 ? state.sessions[existingIndex] : undefined;

    const newSession: GlobalSession = {
      cwd,
      sessionId,
      lastActive: Date.now(),
      status,
      title: truncate(title || existing?.title),
      lastUserMessage: truncate(lastUserMessage || existing?.lastUserMessage),
    };

    if (existingIndex >= 0) {
      state.sessions[existingIndex] = newSession;
    } else {
      state.sessions.push(newSession);
    }

    // Sort by lastActive descending
    state.sessions.sort((a, b) => b.lastActive - a.lastActive);

    // Keep only the most recent MAX_SESSIONS entries
    state.sessions = state.sessions.slice(0, MAX_SESSIONS);

    await writeJsonFile(GLOBAL_STATE_FILE, state);
  });
}

/**
 * Read the session title from a transcript file.
 */
export async function getSessionTitle(cwd: string, sessionId: string): Promise<string> {
  const filePath = getClaudeSessionPath(cwd, sessionId);

  if (!existsSync(filePath)) {
    return 'Untitled Session';
  }

  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let summary = '';
    const userMessages: string[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // Extract summary
        if (entry.type === 'summary' && entry.summary) {
          summary = entry.summary;
        }

        // Extract user message text
        if (entry.type === 'user') {
          const message = entry.message;
          if (message?.content) {
            if (typeof message.content === 'string') {
              userMessages.push(message.content);
            } else if (Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                  userMessages.push(block.text);
                }
              }
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return generateTitle(summary, userMessages);
  } catch {
    return 'Untitled Session';
  }
}

/**
 * Read the last user message from a transcript file.
 */
export async function getLastUserMessage(cwd: string, sessionId: string): Promise<string | undefined> {
  const filePath = getClaudeSessionPath(cwd, sessionId);

  if (!existsSync(filePath)) {
    return undefined;
  }

  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({
      input: fileStream,
      crlfDelay: Infinity,
    });

    let lastUserMessage: string | undefined;

    for await (const line of rl) {
      if (!line.trim()) continue;

      try {
        const entry = JSON.parse(line);

        // Extract user message text
        if (entry.type === 'user') {
          const message = entry.message;
          if (message?.content) {
            let text = '';
            if (typeof message.content === 'string') {
              text = message.content;
            } else if (Array.isArray(message.content)) {
              for (const block of message.content) {
                if (block.type === 'text' && block.text) {
                  text = block.text;
                  break; // Take only the first text block
                }
              }
            }
            if (text) {
              // Strip command tags
              const filtered = filterCommandTags(text);
              // Check if this is a valid user message
              if (filtered && isValidUserMessage(filtered)) {
                lastUserMessage = filtered;
              }
            }
          }
        }
      } catch {
        // Ignore parse errors
      }
    }

    return lastUserMessage;
  } catch {
    return undefined;
  }
}

/**
 * Strip command and system tags from a message.
 */
function filterCommandTags(text: string): string {
  // Remove <command-*> tags and their content
  let filtered = text.replace(/<command-[^>]*>[\s\S]*?<\/command-[^>]*>/g, '');
  // Remove <local-command-*> tags and their content
  filtered = filtered.replace(/<local-command-[^>]*>[\s\S]*?<\/local-command-[^>]*>/g, '');
  // Strip extra whitespace
  filtered = filtered.trim();
  return filtered;
}

/**
 * Check whether a message is a valid user message (not a system message).
 */
function isValidUserMessage(text: string): boolean {
  // Filter out system context messages
  if (text.startsWith('This session is being continued')) return false;
  if (text.startsWith('Caveat: The messages below')) return false;
  // Filter out empty messages
  if (!text.trim()) return false;
  return true;
}

/**
 * Generate a session title.
 */
function generateTitle(summary: string, userMessages: string[]): string {
  if (summary) return summary;

  let commandName = '';
  for (const msg of userMessages) {
    const filtered = filterCommandTags(msg);
    if (!filtered) continue;

    // If this is a command (starts with /), save the name and look for the next message
    if (filtered.startsWith('/') && !commandName) {
      commandName = filtered;
      continue;
    }

    // If a command name was already found, combine them
    if (commandName) {
      return `${commandName} ${filtered}`;
    }

    // Use a plain message directly as the title
    return filtered;
  }

  // If only a command name was found with no follow-up message, use it as the title
  if (commandName) return commandName;

  return 'Untitled Session';
}
