import {
  GLOBAL_STATE_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
  getClaudeSessionPath,
  getOllamaSessionPath,
  getDeepseekBuiltinSessionPath,
  getKimiBuiltinSessionPath,
  getGlmBuiltinSessionPath,
  getSessionFilePath,
} from '@cockpit/shared-utils';
import { detectBotName } from '../../shared/botSession';
import type { GlobalSessionInfo, GlobalSessionRecord, SessionStatus } from '../../shared/sessionDto';

/** Claude-format transcript stores, probed in order by cwd+sessionId. Every API-key engine
 *  runs the Built-in Agent loop and writes exactly one store (~/.cockpit/<engine>-sessions). */
const CLAUDE_STYLE_PATHS = [
  getClaudeSessionPath,
  getOllamaSessionPath,
  getDeepseekBuiltinSessionPath,
  getKimiBuiltinSessionPath,
  getGlmBuiltinSessionPath,
];

/** First existing Claude-format transcript for this session, or null. */
async function findClaudeStylePath(cwd: string, sessionId: string): Promise<string | null> {
  for (const resolve of CLAUDE_STYLE_PATHS) {
    const path = resolve(cwd, sessionId);
    if (await access(path).then(() => true, () => false)) return path;
  }
  return null;
}
import { existsSync } from 'fs';
import { access } from 'fs/promises';
import { basename } from 'path';
import type { TranscriptFormat, TranscriptSnapshot } from '@cockpit/effect-services';
import { findCodexSession, runWithTranscriptIndex } from '../../effect/transcriptIndexLive';
import { codexTitle, previewMessages, titleMessages } from '../transcriptViews';
import { isRunActive } from '../sessionRunHub';
import { sendPushNotification } from '../push/push';
import { generateTitle } from '../sessionTitle';

export type { SessionStatus };

/**
 * state.json's 'loading' is a cache of a fact sessionRunHub already owns. Every writer
 * that forgets to clear it — an explicit stop (requestStop writes no terminal state), a
 * 409 from the scheduled-task retry, a server restart — leaves a dot pulsing forever,
 * and any client status write can wipe one that is still true. So don't trust it on
 * read: the registry decides "running", and a stored 'loading' with no live run means
 * the run ended without a teardown write -> 'unread' (there IS output to look at).
 *
 * Also folds in the legacy isLoading -> status migration both readers duplicated.
 * Mutates in place; call it on every list read out of state.json.
 */
export function normalizeStatuses(sessions: GlobalSession[]): void {
  for (const s of sessions) {
    if (!s.status) {
      const legacy = s as GlobalSession & { isLoading?: boolean };
      s.status = legacy.isLoading ? 'loading' : 'normal';
    }
    if (isRunActive(s.sessionId)) s.status = 'loading';
    else if (s.status === 'loading') s.status = 'unread';
  }
}

/** A persisted session record. Field list: shared/sessionDto.ts. */
export type GlobalSession = GlobalSessionRecord;

interface GlobalState {
  sessions: GlobalSession[];
}

// Retention for the persisted recent-session list, backing the search panel:
//   - keep sessions active within the last week …
//   - … but never fewer than MIN_SESSIONS (pad with older ones if the week is sparse)
//   - … and never more than MAX_SESSIONS.
// The sidebar dropdown still shows only the top 20 (sliced on the WS push path).
const MAX_SESSIONS = 100;
const MIN_SESSIONS = 20;
const RETENTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000; // one week
const MAX_TEXT_LEN = 50; // max character count for title / lastUserMessage

function migrateLegacyStatuses(sessions: GlobalSession[]): void {
  for (const session of sessions) {
    if (session.status) continue;
    const legacy = session as GlobalSession & { isLoading?: boolean };
    session.status = legacy.isLoading ? 'loading' : 'normal';
    delete legacy.isLoading;
  }
}

function retainRecentSessions(state: GlobalState): void {
  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  const cutoff = Date.now() - RETENTION_WINDOW_MS;
  const withinWeek = state.sessions.filter((session) => session.lastActive >= cutoff).length;
  const keep = Math.min(MAX_SESSIONS, Math.max(MIN_SESSIONS, withinWeek));
  state.sessions = state.sessions.slice(0, keep);
}

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
  lastUserMessage?: string,
  engine?: string
): Promise<void> {
  // Guard: skip non-existent paths (avoids writing with a wrongly decoded cwd)
  if (!existsSync(cwd)) {
    return;
  }

  return withFileLock(GLOBAL_STATE_FILE, async () => {
    const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

    migrateLegacyStatuses(state.sessions);

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
      // Carried like title/lastUserMessage: status-only updates (the client's
      // /api/global-state PATCH) pass no engine and must not erase it.
      engine: engine || existing?.engine,
      // A Bot names itself in the session's FIRST message, so only the first
      // write of a session can see it — by the second, `lastUserMessage` has
      // moved on. Hence: derive on insert, carry forward on every update. A
      // session that predates this field stays unmarked here and is marked from
      // disk by getSessionPreview instead, which is the slower but complete path.
      bot: existed ? existing?.bot : detectBotName(lastUserMessage),
    };

    if (existingIndex >= 0) {
      state.sessions[existingIndex] = newSession;
    } else {
      state.sessions.push(newSession);
    }

    retainRecentSessions(state);

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
 * Mark a session as a recently-left work context without changing its live/read state.
 * Unlike a status update this may insert a missing session: leaving an older restored
 * session is precisely what makes it useful as a return point in the recent list.
 */
export async function touchGlobalSession(cwd: string, sessionId: string): Promise<void> {
  if (!existsSync(cwd)) return;

  return withFileLock(GLOBAL_STATE_FILE, async () => {
    const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
    migrateLegacyStatuses(state.sessions);

    const existing = state.sessions.find(
      (session) => session.cwd === cwd && session.sessionId === sessionId
    );
    if (existing) {
      existing.lastActive = Date.now();
    } else {
      state.sessions.push({ cwd, sessionId, lastActive: Date.now(), status: 'normal' });
    }

    retainRecentSessions(state);
    await writeJsonFile(GLOBAL_STATE_FILE, state);
  });
}

/**
 * Change read/live state without treating a UI visit as new session activity.
 * A status-only write never creates a recent entry and preserves its ordering timestamp.
 */
export async function updateGlobalSessionStatus(
  cwd: string,
  sessionId: string,
  status: SessionStatus,
): Promise<void> {
  if (!existsSync(cwd)) return;

  return withFileLock(GLOBAL_STATE_FILE, async () => {
    const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });
    migrateLegacyStatuses(state.sessions);
    const existing = state.sessions.find(
      (session) => session.cwd === cwd && session.sessionId === sessionId
    );
    if (!existing || existing.status === status) return;
    existing.status = status;
    await writeJsonFile(GLOBAL_STATE_FILE, state);
  });
}

/**
 * Locate a session's transcript and its format. Claude-format stores are probed by
 * cwd + sessionId; codex rollouts are looked up by thread id in the codex index.
 */
async function resolveSessionFile(
  cwd: string,
  sessionId: string
): Promise<{ path: string; format: TranscriptFormat } | null> {
  const claudeStylePath = await findClaudeStylePath(cwd, sessionId);
  if (claudeStylePath) return { path: claudeStylePath, format: 'claude' };
  const codex = await findCodexSession(sessionId);
  return codex ? { path: codex.path, format: 'codex' } : null;
}

/** Up-to-date folded transcript for a session, or null when it has none on disk. */
async function sessionSnapshot(cwd: string, sessionId: string): Promise<TranscriptSnapshot | null> {
  const resolved = await resolveSessionFile(cwd, sessionId);
  if (!resolved) return null;
  return runWithTranscriptIndex((index) => index.snapshot(resolved.path, resolved.format));
}

/**
 * Read the session title from a transcript file.
 */
export async function getSessionTitle(cwd: string, sessionId: string): Promise<string> {
  const snap = await sessionSnapshot(cwd, sessionId);
  if (!snap) return UNTITLED_SESSION;
  if (snap.format === 'codex') return codexTitle(snap) || UNTITLED_SESSION;
  return generateTitle(snap.aiTitle, snap.summary, titleMessages(snap));
}

/**
 * Read the last user message from a transcript file.
 */
export async function getLastUserMessage(cwd: string, sessionId: string): Promise<string | undefined> {
  const snap = await sessionSnapshot(cwd, sessionId);
  const messages = snap ? previewMessages(snap) : [];
  return messages[messages.length - 1];
}

const SUMMARY_THRESHOLD = 10; // ≤ this many messages → all go into firstMessages
const SUMMARY_HEAD = 5;
const SUMMARY_TAIL = 5;

export const UNTITLED_SESSION = 'Untitled Session';

export interface SessionPreview {
  /** Live title (summary line preferred), regenerated from disk on every read. */
  title: string;
  /** Bot that dispatched the session, from its first user message. */
  bot?: string;
  lastUserMessage?: string;
  firstMessages: string[];
  lastMessages: string[];
  /**
   * Full, UNTRUNCATED, lowercased corpus for the search panel: summary + every
   * user message in order. Display fields (first/last) stay truncated+sampled;
   * matching must not inherit that lossiness, so search reads this instead.
   * Only populated when the caller passes `{ includeSearchText: true }` (the
   * search-panel GET); the WS snapshot leaves it empty to skip the join cost.
   */
  searchText: string;
}

/** Session content: aiTitle + summary line + filtered user messages. */
interface SessionContent {
  aiTitle: string;
  summary: string;
  messages: string[];
}

/**
 * Title lines plus every user message, from the transcript index — a stat per
 * call when the transcript is unchanged, a parse of only the appended bytes when
 * it has grown.
 */
async function getSessionContent(cwd: string, sessionId: string): Promise<SessionContent> {
  const snap = await sessionSnapshot(cwd, sessionId);
  if (!snap) return { aiTitle: '', summary: '', messages: [] };
  return { aiTitle: snap.aiTitle, summary: snap.summary, messages: previewMessages(snap) };
}

/**
 * Read a session preview in a single pass: a live title, the last user message,
 * a first/last message preview (mirroring ProjectSessionsModal cards — ≤10
 * messages → all in firstMessages; otherwise first 5 + last 5, each truncated to
 * MAX_TEXT_LEN), and an untruncated `searchText` corpus for the search panel.
 */
export async function getSessionPreview(
  cwd: string,
  sessionId: string,
  opts?: { includeSearchText?: boolean }
): Promise<SessionPreview> {
  const { aiTitle, summary, messages } = await getSessionContent(cwd, sessionId);
  const title = generateTitle(aiTitle, summary, messages);
  // `messages` are the session's human turns in order, so [0] is the line a Bot
  // dispatch writes. Free: this read already happened for the title.
  const bot = detectBotName(messages[0]);
  const lastUserMessage = messages[messages.length - 1];
  // Untruncated, unsampled corpus — keeps long messages and mid-conversation
  // messages searchable even though the display fields below drop them. Only the
  // search panel (/api/global-state GET) needs it; the WS snapshot never reads
  // searchText, so skip the multi-MB join+toLowerCase there.
  const searchText = opts?.includeSearchText ? [summary, ...messages].join('\n').toLowerCase() : '';
  if (messages.length <= SUMMARY_THRESHOLD) {
    return { title, bot, lastUserMessage, firstMessages: messages.map((m) => truncate(m)!), lastMessages: [], searchText };
  }
  return {
    title,
    bot,
    lastUserMessage,
    firstMessages: messages.slice(0, SUMMARY_HEAD).map((m) => truncate(m)!),
    lastMessages: messages.slice(-SUMMARY_TAIL).map((m) => truncate(m)!),
    searchText,
  };
}

/** GlobalSession enriched with the preview fields the session list renders. */
export type GlobalSessionSnapshot = GlobalSessionInfo;

/**
 * Attach each session's engine, read from the project state the chat tabs persist
 * (session.json's `engines` map — the same map the per-project session lists read).
 *
 * state.json has carried an `engine` field since forever but NOTHING ever wrote it,
 * so every consumer saw `undefined`: the recent-sessions badge was dead markup that
 * had silently never rendered, which is exactly how its copy of the engine→color
 * chain got to drift without anyone noticing.
 *
 * One read per PROJECT, not per session: a 100-entry cross-project list collapses to
 * a handful of files. Best-effort — an unreadable state file just leaves engine unset,
 * which renders as the neutral default rather than failing the list.
 */
export async function attachEngines<T extends { cwd: string; sessionId: string }>(
  sessions: T[],
): Promise<Array<T & { engine?: string }>> {
  const byCwd = new Map<string, Promise<Record<string, string>>>();
  const enginesFor = (cwd: string): Promise<Record<string, string>> => {
    const cached = byCwd.get(cwd);
    if (cached) return cached;
    const pending = readJsonFile<{ engines?: Record<string, string> }>(getSessionFilePath(cwd), {})
      .then((state) => state.engines ?? {})
      .catch(() => ({}));
    byCwd.set(cwd, pending);
    return pending;
  };

  return Promise.all(
    sessions.map(async (session) => {
      // What the dispatcher recorded wins; the tab-written map is the fallback
      // for sessions that last ran before the dispatcher started writing it.
      const engine =
        (session as { engine?: string }).engine ??
        (await enginesFor(session.cwd))[session.sessionId];
      return engine ? { ...session, engine } : session;
    }),
  );
}

/**
 * Build the recent-sessions snapshot (top `limit`, previews attached) — the
 * exact shape the /ws/global-state channel pushes. Shared by:
 *   - the WS handler (src/lib/effect/globalStateHandler.ts), and
 *   - the /m server page, which SSRs the list so first paint doesn't wait for
 *     JS download + hydration + WS handshake (a ~2s tax on tunneled links).
 */
export async function getGlobalSessionsSnapshot(limit = 20): Promise<GlobalSessionSnapshot[]> {
  const state = await readJsonFile<GlobalState>(GLOBAL_STATE_FILE, { sessions: [] });

  normalizeStatuses(state.sessions);

  state.sessions.sort((a, b) => b.lastActive - a.lastActive);
  const recent = state.sessions.slice(0, limit);

  const previews = await Promise.all(
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
          // Disk wins: it reads the true first message, while the persisted value
          // is only there for sessions this snapshot never opens (the running ones).
          bot: preview.bot ?? session.bot,
          firstMessages: preview.firstMessages,
          lastMessages: preview.lastMessages,
        };
      } catch {
        return session; // preview is best-effort — never block the snapshot
      }
    })
  );

  // After the previews, so the two early-return branches above (already-fresh
  // loading session, preview failure) get an engine too.
  return attachEngines(previews);
}
