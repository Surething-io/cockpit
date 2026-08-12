/**
 * Client-side HTML-apps registry IO — Effect wrappers. Mirrors skillsClient.
 *   - GET    /api/html-apps        — list (enriched with <title>/<meta>)
 *   - POST   /api/html-apps        — add by absolute path
 *   - DELETE /api/html-apps/:id    — remove
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

export interface HtmlAppInfo {
  id: string
  path: string
  addedAt: string
  name: string
  title: string
  description: string
  icon?: string
  valid: boolean
  /**
   * Shipped under /apps and merged in at read time — not stored in html.json,
   * so it cannot be deleted. Absent/false for user-registered apps.
   */
  builtin?: boolean
}

const httpJson = <A>(url: string, init?: RequestInit): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      if (!res.ok) {
        let bodyError: string | undefined
        try {
          const data = (await res.json()) as { error?: string }
          bodyError = data.error
        } catch {
          /* not JSON */
        }
        throw new Error(bodyError || `HTTP ${res.status}`)
      }
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `${init?.method ?? "GET"} ${url} failed`, cause }),
  })

/** GET /api/html-apps — backend returns Array<HtmlAppInfo> directly. */
export const loadHtmlApps = (): Effect.Effect<ReadonlyArray<HtmlAppInfo>, AppError> =>
  httpJson<ReadonlyArray<HtmlAppInfo>>("/api/html-apps")

export interface AddHtmlAppResult extends HtmlAppInfo {
  /** True when the path was already registered (no new entry written). */
  alreadyExists: boolean
}

export const addHtmlApp = (path: string): Effect.Effect<AddHtmlAppResult, AppError> =>
  httpJson<AddHtmlAppResult>("/api/html-apps", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })

export const deleteHtmlApp = (id: string): Effect.Effect<unknown, AppError> =>
  httpJson(`/api/html-apps/${encodeURIComponent(id)}`, { method: "DELETE" })
