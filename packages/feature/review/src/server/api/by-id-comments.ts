/**
 * /api/review/[id]/comments — P8+ migration (POST/PATCH/DELETE)
 */
import { existsSync } from "fs"
import { Effect } from "effect"
import {
  getReviewFilePath,
  readJsonFile,
  writeJsonFile,
  withFileLock,
  notifyReviewChange,
} from "@cockpit/shared-utils"
import {
  dynamicHandler,
  ok,
  parseJsonRaw,
} from "@cockpit/effect-runtime/server"
import {
  FSError,
  NotFoundError,
  ValidationError,
} from "@cockpit/effect-core"
import { ReviewData, generateCommentId } from "../lib/reviewUtils"

interface Params {
  id: string
}

const checkExists = (
  id: string
): Effect.Effect<string, NotFoundError> => {
  const filePath = getReviewFilePath(id)
  return existsSync(filePath)
    ? Effect.succeed(filePath)
    : Effect.fail(new NotFoundError({ resource: "review", id }))
}

export const POST = dynamicHandler<
  Params,
  NotFoundError | ValidationError | FSError
>((req, { id }) =>
  Effect.gen(function* () {
    const filePath = yield* checkExists(id)
    const body = (yield* parseJsonRaw(req)) as {
      author?: string
      authorId?: string
      content?: string
      anchor?: unknown
    }
    if (!body.author || !body.authorId || !body.content || !body.anchor) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.author
            ? "author"
            : !body.authorId
              ? "authorId"
              : !body.content
                ? "content"
                : "anchor",
          reason: "missing",
        })
      )
    }
    const { author, authorId, content, anchor } = body
    const comment = yield* Effect.tryPromise({
      try: () =>
        withFileLock(filePath, async () => {
          const review = await readJsonFile<ReviewData>(
            filePath,
            null as unknown as ReviewData
          )
          if (!review) throw new Error("Review not found")
          const newComment = {
            id: generateCommentId(),
            author,
            authorId,
            content,
            anchor: anchor as ReviewData["comments"][0]["anchor"],
            createdAt: Date.now(),
            replies: [],
          }
          review.comments.push(newComment)
          await writeJsonFile(filePath, review)
          return newComment
        }),
      catch: (cause) =>
        new FSError({ path: filePath, op: "write", cause }),
    })
    notifyReviewChange()
    return ok({ comment })
  })
)

export const PATCH = dynamicHandler<
  Params,
  NotFoundError | ValidationError | FSError
>((req, { id }) =>
  Effect.gen(function* () {
    const filePath = yield* checkExists(id)
    const body = (yield* parseJsonRaw(req)) as {
      commentId?: string
      content?: string
      closed?: boolean
    }
    if (
      !body.commentId ||
      (body.content === undefined && body.closed === undefined)
    ) {
      return yield* Effect.fail(
        new ValidationError({
          field: "commentId|content|closed",
          reason: "commentId and (content or closed) required",
        })
      )
    }
    const { commentId, content, closed } = body
    const result = yield* Effect.tryPromise({
      try: () =>
        withFileLock(filePath, async () => {
          const review = await readJsonFile<ReviewData>(
            filePath,
            null as unknown as ReviewData
          )
          if (!review) throw new Error("Review not found")
          const comment = review.comments.find((c) => c.id === commentId)
          if (!comment) {
            const e = new Error("Comment not found") as Error & {
              notFound: true
            }
            e.notFound = true
            throw e
          }
          if (content !== undefined) {
            comment.content = content.trim()
            comment.edited = true
          }
          if (closed !== undefined) {
            comment.closed = !!closed
          }
          await writeJsonFile(filePath, review)
          return comment
        }),
      catch: (cause) => {
        if (
          cause instanceof Error &&
          (cause as Error & { notFound?: boolean }).notFound
        ) {
          return new NotFoundError({ resource: "comment", id: commentId })
        }
        return new FSError({ path: filePath, op: "write", cause })
      },
    })
    notifyReviewChange()
    return ok({ comment: result })
  })
)

export const DELETE = dynamicHandler<
  Params,
  NotFoundError | ValidationError | FSError
>((req, { id }) =>
  Effect.gen(function* () {
    const commentId = new URL(req.url).searchParams.get("commentId")
    if (!commentId) {
      return yield* Effect.fail(
        new ValidationError({ field: "commentId", reason: "missing" })
      )
    }
    const filePath = yield* checkExists(id)
    yield* Effect.tryPromise({
      try: () =>
        withFileLock(filePath, async () => {
          const review = await readJsonFile<ReviewData>(
            filePath,
            null as unknown as ReviewData
          )
          if (!review) throw new Error("Review not found")
          const idx = review.comments.findIndex((c) => c.id === commentId)
          if (idx === -1) {
            const e = new Error("Comment not found") as Error & {
              notFound: true
            }
            e.notFound = true
            throw e
          }
          review.comments.splice(idx, 1)
          await writeJsonFile(filePath, review)
        }),
      catch: (cause) => {
        if (
          cause instanceof Error &&
          (cause as Error & { notFound?: boolean }).notFound
        ) {
          return new NotFoundError({ resource: "comment", id: commentId })
        }
        return new FSError({ path: filePath, op: "write", cause })
      },
    })
    notifyReviewChange()
    return ok({ success: true })
  })
)
