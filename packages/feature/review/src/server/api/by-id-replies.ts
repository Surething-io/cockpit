/**
 * /api/review/[id]/replies — P8+ migration (POST/PATCH/DELETE)
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
import { ReviewData, generateReplyId } from "../lib/reviewUtils"

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

// Helper: translate internally thrown "Comment not found" / "Reply not found" into NotFoundError
const translateError = (
  filePath: string,
  ids: { commentId?: string; replyId?: string }
) =>
  (cause: unknown): NotFoundError | FSError => {
    if (cause instanceof Error) {
      if (cause.message === "Comment not found") {
        return new NotFoundError({
          resource: "comment",
          id: ids.commentId ?? "?",
        })
      }
      if (cause.message === "Reply not found") {
        return new NotFoundError({
          resource: "reply",
          id: ids.replyId ?? "?",
        })
      }
    }
    return new FSError({ path: filePath, op: "write", cause })
  }

export const POST = dynamicHandler<
  Params,
  NotFoundError | ValidationError | FSError
>((req, { id }) =>
  Effect.gen(function* () {
    const filePath = yield* checkExists(id)
    const body = (yield* parseJsonRaw(req)) as {
      commentId?: string
      author?: string
      authorId?: string
      content?: string
    }
    if (!body.commentId || !body.author || !body.authorId || !body.content) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.commentId
            ? "commentId"
            : !body.author
              ? "author"
              : !body.authorId
                ? "authorId"
                : "content",
          reason: "missing",
        })
      )
    }
    const { commentId, author, authorId, content } = body
    const reply = yield* Effect.tryPromise({
      try: () =>
        withFileLock(filePath, async () => {
          const review = await readJsonFile<ReviewData>(
            filePath,
            null as unknown as ReviewData
          )
          if (!review) throw new Error("Review not found")
          const comment = review.comments.find((c) => c.id === commentId)
          if (!comment) throw new Error("Comment not found")
          const newReply = {
            id: generateReplyId(),
            author,
            authorId,
            content,
            createdAt: Date.now(),
          }
          comment.replies.push(newReply)
          await writeJsonFile(filePath, review)
          return newReply
        }),
      catch: translateError(filePath, { commentId }),
    })
    notifyReviewChange()
    return ok({ reply })
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
      replyId?: string
      content?: string
    }
    if (!body.commentId || !body.replyId || !body.content) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.commentId
            ? "commentId"
            : !body.replyId
              ? "replyId"
              : "content",
          reason: "missing",
        })
      )
    }
    const { commentId, replyId, content } = body
    const updated = yield* Effect.tryPromise({
      try: () =>
        withFileLock(filePath, async () => {
          const review = await readJsonFile<ReviewData>(
            filePath,
            null as unknown as ReviewData
          )
          if (!review) throw new Error("Review not found")
          const comment = review.comments.find((c) => c.id === commentId)
          if (!comment) throw new Error("Comment not found")
          const reply = comment.replies.find((r) => r.id === replyId)
          if (!reply) throw new Error("Reply not found")
          reply.content = content.trim()
          reply.edited = true
          await writeJsonFile(filePath, review)
          return reply
        }),
      catch: translateError(filePath, { commentId, replyId }),
    })
    notifyReviewChange()
    return ok({ reply: updated })
  })
)

export const DELETE = dynamicHandler<
  Params,
  NotFoundError | ValidationError | FSError
>((req, { id }) =>
  Effect.gen(function* () {
    const commentId = new URL(req.url).searchParams.get("commentId")
    const replyId = new URL(req.url).searchParams.get("replyId")
    if (!commentId || !replyId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !commentId ? "commentId" : "replyId",
          reason: "missing",
        })
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
          const comment = review.comments.find((c) => c.id === commentId)
          if (!comment) throw new Error("Comment not found")
          const idx = comment.replies.findIndex((r) => r.id === replyId)
          if (idx === -1) throw new Error("Reply not found")
          comment.replies.splice(idx, 1)
          await writeJsonFile(filePath, review)
        }),
      catch: translateError(filePath, { commentId, replyId }),
    })
    notifyReviewChange()
    return ok({ success: true })
  })
)
