/**
 * Client-side skills-registry IO — Effect wrappers. Endpoints:
 *   - GET    /api/skills            — list
 *   - POST   /api/skills            — add by path
 *   - DELETE /api/skills/:id        — remove
 *   - GET    /api/skills/content?id — preview content
 *
 * Lives in shared-api alongside skillsBus for the same reason: feature-skills
 * (SkillsModal / SkillPreviewModal) and feature-explorer (the SKILL.md "add"
 * buttons) both need it, and homing it in feature-skills would cycle.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

const httpJson = <A>(
  url: string,
  init?: RequestInit
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      if (!res.ok) {
        // Surface the backend's body.error into cause.message; callers display
        // it verbatim in a toast.
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
      new AppError({
        message: `${init?.method ?? "GET"} ${url} failed`,
        cause,
      }),
  })

// ─────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────

export interface SkillInfoLite {
  id: string
  name: string
  description: string
  path: string
  valid?: boolean
  [key: string]: unknown
}

export interface SkillPreviewLite {
  path?: string
  content?: string
  [key: string]: unknown
}

export interface AddSkillResult extends SkillInfoLite {
  /** True when the path was already registered (no new entry written). */
  alreadyExists: boolean
}

// ─────────────────────────────────────────────────────────
// API
// ─────────────────────────────────────────────────────────

/**
 * GET /api/skills — backend returns Array<SkillInfo> directly (not wrapped in `{skills:[]}`).
 */
export const loadSkillsList = <T = SkillInfoLite>(): Effect.Effect<
  ReadonlyArray<T>,
  AppError
> => httpJson<ReadonlyArray<T>>("/api/skills")

export const addSkill = (
  path: string
): Effect.Effect<AddSkillResult, AppError> =>
  httpJson<AddSkillResult>("/api/skills", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ path }),
  })

export const deleteSkill = (id: string): Effect.Effect<unknown, AppError> =>
  httpJson(`/api/skills/${encodeURIComponent(id)}`, { method: "DELETE" })

export const loadSkillContent = <T = SkillPreviewLite>(
  id: string
): Effect.Effect<T, AppError> =>
  httpJson<T>(`/api/skills/content?id=${encodeURIComponent(id)}`)
