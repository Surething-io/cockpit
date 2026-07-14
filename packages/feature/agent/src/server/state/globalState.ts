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
} from '@cockpit/shared-utils';
import { createReadStream, existsSync } from 'fs';
import { createInterface } from 'readline';
import { basename } from 'path';
import { sendPushNotification } from '../push/push';
import { generateTitle } from '../sessionTitle';

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

// Retention for the persisted recent-session list, backing the search panel:
//   - keep sessions active within the last week …
//   - … but never fewer than MIN_SESSIONS (pad with older ones if the week is sparse)
//   - … and never more than MAX_SESSIONS.
// The sidebar dropdown still shows only the top 15 (sliced on the WS push path).
const MAX_SESSIONS = 100;
const MIN_SESSIONS = 15;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // one week
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

    // Retention: keep the past week, clamped to [MIN_SESSIONS, MAX_SESSIONS].
    // Sessions are sorted newest-first, so the within-week ones are a contiguous
    // prefix — counting them gives the cut point directly.
    const cutoff = Date.now() - RETENTION_WINDOW_MS;
    const withinWeek = state.sessions.filter((s) => s.lastActive >= cutoff).length;
    const keep = Math.min(MAX_SESSIONS, Math.max(MIN_SESSIONS, withinWeek));
    state.sessions = state.sessions.slice(0, keep);

    await writeJsonFile(GLOBAL_STATE_FILE, state);

    // Web Push: notify once when a run finishes (status enters 'unread').
    // Gated on the previous status so repeated 'unread' writes don't re-notify.
    // Fire-and-forget — never blocks or fails the state write.
    if (status === 'unread' && existing?.status !== 'unread') {
      void (async () => {
        // Read the transcript for the *actual* latest user prompt at completion
        // time — authoritative even for scheduled-task / failure writes that
        // don't carry a fresh lastUserMessage. Fall back to the cached value,
        // then the title. Empty → SW localizes the body.
        const fresh = await getLastUserMessage(cwd, sessionId).catch(() => undefined);
        const last = fresh || newSession.lastUserMessage;
        await sendPushNotification({
          title: basename(cwd) || 'Cockpit',
          body: truncate(last) || newSession.title || '',
          data: { cwd, sessionId },
        });
      })().catch(() => {});
    }
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
 * Collect every valid user message from a transcript file, in order,
 * dispatching by engine format (Claude-style / Codex / Kimi).
 */
async function collectUserMessages(cwd: string, sessionId: string): Promise<string[]> {
  const claudePath = getClaudeSessionPath(cwd, sessionId);
  if (existsSync(claudePath)) {
    return await getClaudeStyleUserMessages(claudePath);
  }

  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (existsSync(claude2Path)) {
    return await getClaudeStyleUserMessages(claude2Path);
  }

  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (existsSync(ollamaPath)) {
    return await getClaudeStyleUserMessages(ollamaPath);
  }

  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath && existsSync(codexPath)) {
    return await getCodexUserMessages(codexPath);
  }

  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath && existsSync(kimiPath)) {
    return await getKimiUserMessages(kimiPath);
  }

  return [];
}

/**
 * Read the last user message from a transcript file.
 */
export async function getLastUserMessage(cwd: string, sessionId: string): Promise<string | undefined> {
  const messages = await collectUserMessages(cwd, sessionId);
  return messages[messages.length - 1];
}

const SUMMARY_THRESHOLD = 10; // ≤ this many messages → all go into firstMessages
const SUMMARY_HEAD = 5;
const SUMMARY_TAIL = 5;

export const UNTITLED_SESSION = 'Untitled Session';

export interface SessionPreview {
  /** Live title (summary line preferred), regenerated from disk on every read. */
  title: string;
  lastUserMessage?: string;
  firstMessages: string[];
  lastMessages: string[];
  /**
   * Full, UNTRUNCATED, lowercased corpus for the search panel: summary + every
   * user message in order. Display fields (first/last) stay truncated+sampled;
   * matching must not inherit that lossiness, so search reads this instead.
   */
  searchText: string;
}

/** Session content read in a single pass: aiTitle + summary line + all user messages. */
interface SessionContent {
  aiTitle: string;
  summary: string;
  messages: string[];
}

/**
 * Collect the summary line plus every user message in a single file pass,
 * dispatching by engine. Codex/Kimi transcripts have no summary line (their
 * title is the first user message, already covered by `messages`).
 */
async function getSessionContent(cwd: string, sessionId: string): Promise<SessionContent> {
  const claudePath = getClaudeSessionPath(cwd, sessionId);
  if (existsSync(claudePath)) return getClaudeStyleContent(claudePath);

  const claude2Path = getClaude2SessionPath(cwd, sessionId);
  if (existsSync(claude2Path)) return getClaudeStyleContent(claude2Path);

  const ollamaPath = getOllamaSessionPath(cwd, sessionId);
  if (existsSync(ollamaPath)) return getClaudeStyleContent(ollamaPath);

  const codexPath = findCodexSessionPath(sessionId);
  if (codexPath && existsSync(codexPath)) {
    return { aiTitle: '', summary: '', messages: await getCodexUserMessages(codexPath) };
  }

  const kimiPath = findKimiSessionPath(sessionId);
  if (kimiPath && existsSync(kimiPath)) {
    return { aiTitle: '', summary: '', messages: await getKimiUserMessages(kimiPath) };
  }

  return { aiTitle: '', summary: '', messages: [] };
}

/**
 * Read a session preview in a single pass: a live title, the last user message,
 * a first/last message preview (mirroring ProjectSessionsModal cards — ≤10
 * messages → all in firstMessages; otherwise first 5 + last 5, each truncated to
 * MAX_TEXT_LEN), and an untruncated `searchText` corpus for the search panel.
 */
export async function getSessionPreview(cwd: string, sessionId: string): Promise<SessionPreview> {
  const { aiTitle, summary, messages } = await getSessionContent(cwd, sessionId);
  const title = generateTitle(aiTitle, summary, messages);
  const lastUserMessage = messages[messages.length - 1];
  // Untruncated, unsampled corpus — keeps long messages and mid-conversation
  // messages searchable even though the display fields below drop them.
  const searchText = [summary, ...messages].join('\n').toLowerCase();
  if (messages.length <= SUMMARY_THRESHOLD) {
    return { title, lastUserMessage, firstMessages: messages.map((m) => truncate(m)!), lastMessages: [], searchText };
  }
  return {
    title,
    lastUserMessage,
    firstMessages: messages.slice(0, SUMMARY_HEAD).map((m) => truncate(m)!),
    lastMessages: messages.slice(-SUMMARY_TAIL).map((m) => truncate(m)!),
    searchText,
  };
}

/** GlobalSession enriched with the preview fields the session list renders. */
export interface GlobalSessionSnapshot extends GlobalSession {
  firstMessages?: string[];
  lastMessages?: string[];
}

/**
 * Build the recent-sessions snapshot (top `limit`, previews attached) — the
 * exact shape the /ws/global-state channel pushes. Shared by:
 *   - the WS handler (src/lib/effect/globalStateHandler.ts), and
 *   - the /m server page, which SSRs the list so first paint doesn't wait for
 *     JS download + hydration + WS handshake (a ~2s tax on tunneled links).
 */
export async function getGlobalSessionsSnapshot(limit = 15): Promise<GlobalSessionSnapshot[]> {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

  // backward-compat: isLoading → status
  for (const s of state.sessions) {
    if (!s.status) {
      const legacy = s as GlobalSession & { isLoading?: boolean };
      s.status = legacy.isLoading ? 'loading' : 'normal';
    }
  }

  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  const recent = state.sessions.slice(0, limit);

  return Promise.all(
    recent.map(async (session): Promise<GlobalSessionSnapshot> => {
      // Actively-loading sessions already carry a fresh lastUserMessage.
      if (session.status === 'loading' && session.lastUserMessage) return session;
      try {
        const preview = await getSessionPreview(session.cwd, session.sessionId);
        return {
          ...session,
          // Re-derive the title from disk on every read (aiTitle > summary >
          // first message) instead of trusting the value persisted in
          // state.json — that snapshot is only refreshed when a run finishes,
          // so it goes stale whenever the aiTitle lands after completion.
          // Fall back to the persisted title only when the transcript is gone
          // (preview degrades to UNTITLED_SESSION). Mirrors /api/global-state.
          title:
            preview.title !== UNTITLED_SESSION
              ? preview.title
              : (session.title ?? preview.title),
          lastUserMessage: preview.lastUserMessage ?? session.lastUserMessage,
          firstMessages: preview.firstMessages,
          lastMessages: preview.lastMessages,
        };
      } catch {
        return session; // preview is best-effort — never block the snapshot
      }
    })
  );
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

    let aiTitle = '';
    let summary = '';
    const userMessages: string[] = [];

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'ai-title' && entry.aiTitle) {
          aiTitle = entry.aiTitle;
        }
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

    return generateTitle(aiTitle, summary, userMessages);
  } catch {
    return 'Untitled Session';
  }
}

async function getClaudeStyleUserMessages(filePath: string): Promise<string[]> {
  const messages: string[] = [];
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

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
          messages.push(filtered);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return messages;
}

/**
 * Single-pass Claude-style reader returning the summary line plus the filtered
 * user messages (same filtering as getClaudeStyleUserMessages). Lets
 * getSessionPreview build title + preview + search corpus from one file read.
 */
async function getClaudeStyleContent(filePath: string): Promise<SessionContent> {
  let aiTitle = '';
  let summary = '';
  const messages: string[] = [];
  try {
    const fileStream = createReadStream(filePath);
    const rl = createInterface({ input: fileStream, crlfDelay: Infinity });

    for await (const line of rl) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry.type === 'ai-title' && entry.aiTitle) {
          aiTitle = entry.aiTitle;
          continue;
        }
        if (entry.type === 'summary' && entry.summary) {
          summary = entry.summary;
          continue;
        }
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
          messages.push(filtered);
        }
      } catch {
        // ignore
      }
    }
  } catch {
    // ignore
  }
  return { aiTitle, summary, messages };
}

async function getCodexUserMessages(filePath: string): Promise<string[]> {
  const messages: string[] = [];
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

      const filtered = filterCommandTags(text);
      if (filtered && isValidUserMessage(filtered)) {
        messages.push(filtered);
      }
    }
  } catch {
    // ignore
  }
  return messages;
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

async function getKimiUserMessages(filePath: string): Promise<string[]> {
  const messages: string[] = [];
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

      const filtered = filterCommandTags(text);
      if (filtered && isValidUserMessage(filtered)) {
        messages.push(filtered);
      }
    }
  } catch {
    // ignore
  }
  return messages;
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

