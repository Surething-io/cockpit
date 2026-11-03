/**
 * Session DTOs — the shapes the session APIs return and the session lists render.
 *
 * Why they live here: `shared/` is feature-agent's client-importable zone (no
 * node built-ins, same rule as botSession.ts), and a session is agent-domain
 * data. The tab strip and SessionBrowser sit in feature-workspace, which is
 * allowed to depend on feature-agent — so one declaration reaches every reader.
 *
 * Why they exist at all: each of these two shapes had FOUR hand-written copies —
 * the server builder, the route, and one per consuming component. Adding a
 * single optional field (`bot`) meant seven edits, and the eighth copy
 * (server/api/sessions.ts, an endpoint with no callers left) silently diverged
 * without anyone noticing. Field lists now live in exactly one place; the old
 * local names survive as aliases where a module's own vocabulary reads better.
 */

/** Run state of a session, as persisted in state.json. */
export type SessionStatus = 'normal' | 'loading' | 'unread'

/** Engines that write a transcript, i.e. everything a session list can show. */
export type SessionEngine = 'claude' | 'ollama' | 'codex' | 'kimi' | 'deepseek' | 'glm' | 'grok'

/** One row of a project's session list (`/api/sessions/projects/[encodedPath]`). */
export interface SessionListItem {
  sessionId?: string
  path: string
  title: string
  modifiedAt: string
  firstMessages: string[]
  lastMessages: string[]
  /**
   * Untruncated, lowercased full-text corpus (title/summary + every user
   * message) for the search panel. The display fields above stay truncated and
   * sampled; matching reads this so long-message tails stay searchable.
   */
  searchText?: string
  /**
   * Which engine wrote this transcript, derived from the store it lives in.
   * Display only — reopening a session re-derives it from the file's location.
   */
  engine?: SessionEngine
  /** Bot that dispatched this session, from its first message (botSession.ts). */
  bot?: string
}

/** A session as persisted in `state.json` (the cross-project recent list). */
export interface GlobalSessionRecord {
  cwd: string
  sessionId: string
  lastActive: number
  status: SessionStatus
  title?: string
  lastUserMessage?: string
  /** Written by the dispatcher; `attachEngines` fills it in for older records. */
  engine?: string
  /**
   * Bot that dispatched this session, derived once from its first message.
   * Persisted rather than re-derived per read because the snapshot's hot path
   * skips the transcript entirely for a RUNNING session.
   */
  bot?: string
}

/**
 * A persisted session enriched with the preview fields the lists render
 * (`/api/global-state`, `/ws/global-state`). The preview half is optional: the
 * snapshot attaches it per session and best-effort, so a missing transcript
 * degrades to the bare record rather than dropping the row.
 */
export interface GlobalSessionInfo extends GlobalSessionRecord {
  firstMessages?: string[]
  lastMessages?: string[]
  /** Only the search-panel GET populates this; the WS snapshot leaves it empty. */
  searchText?: string
}
