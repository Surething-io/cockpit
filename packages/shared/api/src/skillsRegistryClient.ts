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
import { httpJson } from "./httpJson"


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

/**
 * GET /api/skills/builtin — the builtin skills shipped with the package (hidden
 * ones excluded), same row shape as loadSkillsList. Read-only: ids are
 * `builtin:<cmd>`, accepted by loadSkillContent but never by deleteSkill.
 */
export const loadBuiltinSkills = <T = SkillInfoLite>(): Effect.Effect<
  ReadonlyArray<T>,
  AppError
> => httpJson<ReadonlyArray<T>>("/api/skills/builtin")

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

/**
 * Directory browsing for the boards whose items are directories — skills and
 * Bots. Both routes take `?id=` (list) and `?id=&path=` (read one file) and
 * answer the same shapes, so one component renders either.
 */
export type DirFilesEndpoint = "/api/skills/files" | "/api/bots/files"

/** One file of the directory. */
export interface DirFileLite {
  /** POSIX path relative to the directory. */
  path: string
  size: number
}

export const loadDirFiles = (
  endpoint: DirFilesEndpoint,
  id: string
): Effect.Effect<{ dir: string; files: DirFileLite[]; truncated: boolean }, AppError> =>
  httpJson(`${endpoint}?id=${encodeURIComponent(id)}`)

/** A file's content; `kind` other than "text" means listed but not served. */
export interface DirFileContent {
  path: string
  kind: "text" | "binary" | "tooLarge"
  content?: string
  size: number
}

export const loadDirFile = (
  endpoint: DirFilesEndpoint,
  id: string,
  path: string
): Effect.Effect<DirFileContent, AppError> =>
  httpJson(`${endpoint}?id=${encodeURIComponent(id)}&path=${encodeURIComponent(path)}`)
