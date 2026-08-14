/**
 * Wire contract for /api/files/* — the single source of truth both sides import.
 *
 * TYPES ONLY. No runtime code, no imports with side effects: this file is read
 * by the Next route handlers (server bundle) AND by the browser clients, and it
 * must compile away to nothing in both.
 *
 * Why this exists: `parseJsonRaw` hands the handler an `unknown`, so every route
 * used to name its own fields via `as { ... }` while the client named them again
 * in an inline literal. Nothing tied the two lists together, and
 * /api/files/clipboard shipped with the client sending `paths: [path]` against a
 * server reading `path` — a 100% failure that typechecked cleanly. Importing the
 * same interface on both sides turns that class of drift into a compile error.
 */

/**
 * POST /api/files/clipboard — put a file reference on the system clipboard.
 *
 * `path` is relative to `cwd` (same convention as /api/files/delete). The server
 * resolves it under `cwd` and rejects anything that escapes.
 */
export interface ClipboardWriteRequest {
  cwd: string
  path: string
}

/**
 * GET /api/files/clipboard — read back the file reference, if any.
 *
 * `path` is absolute, or null when the clipboard holds no readable file path.
 */
export interface ClipboardReadResponse {
  path: string | null
}
