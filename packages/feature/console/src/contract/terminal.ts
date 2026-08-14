/**
 * Wire contract for /api/terminal/bubble-order — imported by both sides.
 *
 * TYPES ONLY. No runtime code: this file is read by the Next route handler
 * (server bundle) and by the browser client, and must compile away in both.
 *
 * Why this exists: `ShortIdBadge` hand-rolled a `fetch` and read
 * `j.data.titles`, but this route is NOT one of the `/api/terminal/*` endpoints
 * intercepted in src/lib/httpApi.ts (that interceptor matches POST against
 * /^\/api\/terminal\/([a-z]+)$/, which a GET to a hyphenated path fails twice
 * over), so it returns a bare `ok()` body with no `{ok, data}` envelope. Two
 * response shapes under one URL prefix; the badge guessed the wrong one and
 * silently lost every saved title across reloads.
 */

/** GET /api/terminal/bubble-order?cwd&tabId */
export interface BubbleOrderResponse {
  /** Bubble ids in display order. */
  order: string[]
  /** fullId → user-set title (commandId for terminal, fullId for browser). */
  titles: Record<string, string>
}

/**
 * POST /api/terminal/bubble-order — partial patch.
 *
 * `order` and `titles` are independently optional: sending one leaves the other
 * untouched. An empty-string title deletes that entry (see `mergeTitles`).
 */
export interface BubbleOrderPatchRequest {
  cwd: string
  tabId: string
  order?: string[]
  titles?: Record<string, string>
  /** Echoed back over the global-state socket so other tabs can ignore their own writes. */
  sourceId?: string
}
