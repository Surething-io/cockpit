/**
 * Client-side review IO — Effect wrappers
 *
 * Wraps the ~22 fetch call sites across 4 files (ReviewPage / ReviewListPanel /
 * ReviewDropdown / ShareReviewToggle).
 *
 * Domain layout: 6 endpoint groups (review CRUD + order + users + share-info + comments + replies),
 * with a consistent shape — JSON body in / JSON body out, failures uniformly mapped to AppError.
 */
import { Effect } from "effect"
import { AppError, NotFoundError } from "@cockpit/effect-core"

// ─────────────────────────────────────────────────────────
// HTTP primitives — same as commentsClient / scheduledTasksClient
// ─────────────────────────────────────────────────────────

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
      new AppError({
        message: `${init?.method ?? "GET"} ${url} failed`,
        cause,
      }),
  })

/**
 * GET where 404 raises NotFoundError separately (other 4xx → AppError).
 * Used by ReviewPage.fetchReview to distinguish "review does not exist" from "network error".
 */
const httpGetWith404 = <A>(
  url: string,
  resourceTag: string
): Effect.Effect<A, AppError | NotFoundError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url)
      if (res.status === 404) {
        throw Object.assign(new Error("not found"), { __404__: true })
      }
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) => {
      if ((cause as { __404__?: boolean })?.__404__) {
        return new NotFoundError({ resource: resourceTag, id: url })
      }
      return new AppError({ message: `GET ${url} failed`, cause })
    },
  })

const httpPostJson = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  httpJson<A>(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const httpPatchJson = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  httpJson<A>(url, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const httpPutJson = <A>(
  url: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  httpJson<A>(url, {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  })

const httpDelete = <A>(url: string): Effect.Effect<A, AppError> =>
  httpJson<A>(url, { method: "DELETE" })

// ─────────────────────────────────────────────────────────
// Reviews list / CRUD
// ─────────────────────────────────────────────────────────

export interface ReviewSummary {
  id: string
  title?: string
  [key: string]: unknown
}

export interface ReviewDetail {
  id: string
  title?: string
  content?: string
  comments?: ReadonlyArray<unknown>
  [key: string]: unknown
}

export const loadReviews = (): Effect.Effect<
  { reviews?: ReadonlyArray<ReviewSummary> },
  AppError
> => httpJson("/api/review")

export const loadReviewById = (
  id: string
): Effect.Effect<{ review: ReviewDetail }, AppError | NotFoundError> =>
  httpGetWith404(`/api/review/${encodeURIComponent(id)}`, "review")

export const createReview = (
  body: Record<string, unknown>
): Effect.Effect<{ id?: string; review?: ReviewDetail }, AppError> =>
  httpPostJson("/api/review", body)

/** PUT /api/review/:id — update review (active/title, etc.). Backend uses PUT, not PATCH. */
export const updateReview = (
  id: string,
  body: Record<string, unknown>
): Effect.Effect<unknown, AppError> =>
  httpPutJson(`/api/review/${encodeURIComponent(id)}`, body)

export const deleteReview = (
  id: string
): Effect.Effect<unknown, AppError> =>
  httpDelete(`/api/review/${encodeURIComponent(id)}`)

/** PUT /api/review/order — backend body field is `order`, not `orderedIds`. */
export const reorderReviews = (
  order: ReadonlyArray<string>
): Effect.Effect<unknown, AppError> =>
  httpPutJson("/api/review/order", { order })

// ─────────────────────────────────────────────────────────
// Users / share-info
// ─────────────────────────────────────────────────────────

export const loadReviewUsers = (): Effect.Effect<
  { users: Record<string, { name: string }> },
  AppError
> => httpJson("/api/review/users")

export const loadShareInfo = (): Effect.Effect<
  { shareBase?: string; [key: string]: unknown },
  AppError
> => httpJson("/api/review/share-info")

// ─────────────────────────────────────────────────────────
// Comments (per review)
// ─────────────────────────────────────────────────────────

export const addReviewComment = (
  reviewId: string,
  body: {
    author?: string
    authorId?: string
    content: string
    anchor?: unknown
  }
): Effect.Effect<unknown, AppError> =>
  httpPostJson(`/api/review/${encodeURIComponent(reviewId)}/comments`, body)

export const patchReviewComment = (
  reviewId: string,
  body: { commentId: string; content?: string; closed?: boolean }
): Effect.Effect<unknown, AppError> =>
  httpPatchJson(`/api/review/${encodeURIComponent(reviewId)}/comments`, body)

export const deleteReviewComment = (
  reviewId: string,
  commentId: string
): Effect.Effect<unknown, AppError> =>
  httpDelete(
    `/api/review/${encodeURIComponent(reviewId)}/comments?commentId=${encodeURIComponent(commentId)}`
  )

// ─────────────────────────────────────────────────────────
// Replies (per review)
// ─────────────────────────────────────────────────────────

export const addReviewReply = (
  reviewId: string,
  body: {
    commentId: string
    author?: string
    authorId?: string
    content: string
  }
): Effect.Effect<unknown, AppError> =>
  httpPostJson(`/api/review/${encodeURIComponent(reviewId)}/replies`, body)

export const patchReviewReply = (
  reviewId: string,
  body: { commentId: string; replyId: string; content: string }
): Effect.Effect<unknown, AppError> =>
  httpPatchJson(`/api/review/${encodeURIComponent(reviewId)}/replies`, body)

export const deleteReviewReply = (
  reviewId: string,
  commentId: string,
  replyId: string
): Effect.Effect<unknown, AppError> =>
  httpDelete(
    `/api/review/${encodeURIComponent(reviewId)}/replies?commentId=${encodeURIComponent(commentId)}&replyId=${encodeURIComponent(replyId)}`
  )
