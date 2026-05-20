/**
 * Client-side comments IO — Effect wrappers
 *
 * Wraps the 7 fetch calls across useComments + useAllComments. The four endpoint
 * verb combinations (GET / POST / PUT / DELETE) are collapsed into 4 wrappers.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import type { CodeComment } from "../../server/api/comments"

const httpJson = <A>(
  url: string,
  init?: RequestInit
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `${init?.method ?? "GET"} ${url} failed`, cause }),
  })

const httpSend = (
  url: string,
  init: RequestInit
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, init)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: `${init.method} ${url} failed`, cause }),
  })

// ─────────────────────────────────────────────────────────
// GET /api/comments — supports filePath filter (single file) or full project
// ─────────────────────────────────────────────────────────

export const loadComments = (
  cwd: string,
  filePath?: string
): Effect.Effect<{ comments?: ReadonlyArray<CodeComment> }, AppError> => {
  const url = `/api/comments?cwd=${encodeURIComponent(cwd)}${filePath ? `&filePath=${encodeURIComponent(filePath)}` : ""}`
  return httpJson(url)
}

/**
 * Full project comments (`?cwd=&all=true`); used by CommentsListModal for
 * an all-files review.
 */
export const loadAllProjectComments = (
  cwd: string
): Effect.Effect<{ comments?: ReadonlyArray<CodeComment> }, AppError> =>
  httpJson(`/api/comments?cwd=${encodeURIComponent(cwd)}&all=true`)

// ─────────────────────────────────────────────────────────
// POST /api/comments
// ─────────────────────────────────────────────────────────

export interface AddCommentBody {
  cwd: string
  filePath: string
  startLine: number
  endLine: number
  content: string
  selectedText?: string
}

export const addComment = (
  body: AddCommentBody
): Effect.Effect<{ comment?: CodeComment }, AppError> =>
  httpJson("/api/comments", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

// ─────────────────────────────────────────────────────────
// PUT /api/comments
// ─────────────────────────────────────────────────────────

export const updateComment = (
  cwd: string,
  id: string,
  content: string
): Effect.Effect<{ comment?: CodeComment }, AppError> =>
  httpJson("/api/comments", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, id, content }),
  })

// ─────────────────────────────────────────────────────────
// DELETE /api/comments?cwd=...&id=... (or &all=true)
// ─────────────────────────────────────────────────────────

export const deleteComment = (
  cwd: string,
  id: string
): Effect.Effect<void, AppError> =>
  httpSend(
    `/api/comments?cwd=${encodeURIComponent(cwd)}&id=${encodeURIComponent(id)}`,
    { method: "DELETE" }
  )

export const deleteAllComments = (cwd: string): Effect.Effect<void, AppError> =>
  httpSend(
    `/api/comments?cwd=${encodeURIComponent(cwd)}&all=true`,
    { method: "DELETE" }
  )
