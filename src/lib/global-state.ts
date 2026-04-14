import {
  GLOBAL_STATE_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
  getClaudeSessionPath,
  getClaude2SessionPath,
  getOllamaSessionPath,
  findCodexSessionPath,
  findKimiSessionPath,
} from './paths';
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
  engine?: 'claude' | 'claude2' | 'codex' | 'ollama';
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
    const existed = existingIndex >= 0;
    const existing = existed ? state.sessions[existingIndex] : undefined;

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
  const claudePath = getClaudeSessionPath(cwd, sessionId);
  if (existsSync(claudePath)) {
    return getClaudeStyleTitle(claudePath);
  }

  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (existsSync(claude2Path)) {
    return getClaudeStyleTitle(claude2Path);
  }

  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (existsSync(ollamaPath)) {
    return getClaudeStyleTitle(ollamaPath);
  }

  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath && existsSync(codexPath)) {
    const title = await getCodexTitle(codexPath);
    return title || 'Untitled Session';
  }

  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath && existsSync(kimiPath)) {
    const title = await getKimiTitle(kimiPath);
    return title || 'Untitled Session';
  }

  return 'Untitled Session';
}

/**
 * Read the last user message from a transcript file.
 */
export async function getLastUserMessage(cwd: string, sessionId: string): Promise<string | undefined> {
  const claudePath = getClaudeSessionPath(cwd, sessionId);
  if (existsSync(claudePath)) {
    return await getClaudeStyleLastUserMessage(claudePath);
  }

  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (existsSync(claude2Path)) {
    return await getClaudeStyleLastUserMessage(claude2Path);
  }

  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (existsSync(ollamaPath)) {
    return await getClaudeStyleLastUserMessage(ollamaPath);
  }

  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath && existsSync(codexPath)) {
    return await getCodexLastUserMessage(codexPath);
  }

  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath && existsSync(kimiPath)) {
    return await getKimiLastUserMessage(kimiPath);
  }

  return undefined;
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

// ============================================
// Transcript readers (Claude-style, Codex, Kimi)
// ============================================

async function getClaudeStyleTitle(filePath: string): Promise<string> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    let summary = '';
    const userMessages: string[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'summary' && entry.summary) {
          summary = entry.summary;
        }
        if (entry.type === 'user') {
          const message = entry.message;
          if (!message?.content) continue;
          if (typeof message.content === 'string') {
            userMessages.push(message.content);
          } else if (Array.isArray(message.content)) {
            for (const block of message.content) {
              if (block.type === 'text' && block.text) userMessages.push(block.text);
            }
          }
        }
      } catch {
        // ignore
      }
    }

    return generateTitle(summary, userMessages);
  } catch {
    return 'Untitled Session';
  }
}

async function getClaudeStyleLastUserMessage(filePath: string): Promise<string | undefined> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    let lastUserMessage: string | undefined;

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type !== 'user') continue;

        const message = entry.message;
        if (!message?.content) continue;

        let text = '';
        if (typeof message.content === 'string') {
          text = message.content;
        } else if (Array.isArray(message.content)) {
          for (const block of message.content) {
            if (block.type === 'text' && block.text) {
              text = block.text;
              break;
            }
          }
        }

        if (!text) continue;
        const filtered = filterCommandTags(text);
        if (filtered && isValidUserMessage(filtered)) {
          lastUserMessage = filtered;
        }
      } catch {
        // ignore
      }
    }

    return lastUserMessage;
  } catch {
    return undefined;
  }
}

async function getCodexLastUserMessage(filePath: string): Promise<string | undefined> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    let last: string | undefined;

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'response_item') continue;
      const payload = entry.payload;
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

      const text =
        payload.content
          ?.filter((c) => c.type === 'input_text' && c.text)
          .map((c) => c.text!)
          .join('') || '';

      if (!text || text.startsWith('<') || text.startsWith('#')) continue;

      const filtered = filterCommandTags(text);
      if (filtered && isValidUserMessage(filtered)) {
        last = filtered;
      }
    }

    return last;
  } catch {
    return undefined;
  }
}

async function getCodexTitle(filePath: string): Promise<string | undefined> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { type?: string; payload?: { type?: string; role?: string; content?: Array<{ type?: string; text?: string }> } };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.type !== 'response_item') continue;
      const payload = entry.payload;
      if (!payload || payload.type !== 'message' || payload.role !== 'user') continue;

      const text =
        payload.content
          ?.filter((c) => c.type === 'input_text' && c.text)
          .map((c) => c.text!)
          .join('') || '';

      if (!text || text.startsWith('<') || text.startsWith('#')) continue;
      return text.slice(0, 80);
    }

    return undefined;
  } catch {
    return undefined;
  }
}

async function getKimiLastUserMessage(filePath: string): Promise<string | undefined> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    let last: string | undefined;

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.role !== 'user') continue;

      const text =
        typeof entry.content === 'string'
          ? entry.content
          : Array.isArray(entry.content)
            ? entry.content
                .filter((c) => (c.type === 'input_text' || c.type === 'text') && c.text)
                .map((c) => c.text!)
                .join('')
            : '';

      if (
        !text ||
        text.startsWith('<system') ||
        text.startsWith('<environment') ||
        text.startsWith('# AGENTS.md') ||
        text.startsWith('<permissions')
      ) {
        continue;
      }

      const filtered = filterCommandTags(text);
      if (filtered && isValidUserMessage(filtered)) {
        last = filtered;
      }
    }

    return last;
  } catch {
    return undefined;
  }
}

async function getKimiTitle(filePath: string): Promise<string | undefined> {
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      let entry: { role?: string; content?: string | Array<{ type?: string; text?: string }> };
      try {
        entry = JSON.parse(line);
      } catch {
        continue;
      }

      if (entry.role !== 'user') continue;

      const text =
        typeof entry.content === 'string'
          ? entry.content
          : Array.isArray(entry.content)
            ? entry.content
                .filter((c) => (c.type === 'input_text' || c.type === 'text') && c.text)
                .map((c) => c.text!)
                .join('')
            : '';

      if (
        !text ||
        text.startsWith('<system') ||
        text.startsWith('<environment') ||
        text.startsWith('# AGENTS.md') ||
        text.startsWith('<permissions')
      ) {
        continue;
      }

      return text.slice(0, 80);
    }

    return undefined;
  } catch {
    return undefined;
  }
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
