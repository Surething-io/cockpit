/**
 * /api/review/[id] — P8+ migration (GET / PUT / DELETE)
 */
import { existsSync } from "fs"
import { unlink } from "fs/promises"
import { Effect } from "effect"
import {
  getReviewFilePath,
  readJsonFile,
  writeJsonFile,
  withFileLock,
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
import { ReviewData } from "../lib/reviewUtils"

interface Params {
  id: string
}

export const GET = dynamicHandler<Params, NotFoundError | FSError>(
  (_req, { id }) =>
    Effect.gen(function* () {
      const filePath = getReviewFilePath(id)
      if (!existsSync(filePath)) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "review", id })
        )
      }
      const review = yield* Effect.tryPromise({
        try: () =>
          readJsonFile<ReviewData>(
            filePath,
            null as unknown as ReviewData
          ),
        catch: (cause) =>
          new FSError({ path: filePath, op: "read", cause }),
      })
      if (!review) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "review", id })
        )
      }
      return ok({ review })
    })
)

export const PUT = dynamicHandler<
  Params,
  NotFoundError | FSError | ValidationError
>(
  (req, { id }) =>
    Effect.gen(function* () {
      const filePath = getReviewFilePath(id)
      if (!existsSync(filePath)) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "review", id })
        )
      }
      const body = (yield* parseJsonRaw(req)) as {
        active?: boolean
        title?: string
      }
      const updated = yield* Effect.tryPromise({
        try: () =>
          withFileLock(filePath, async () => {
            const review = await readJsonFile<ReviewData>(
              filePath,
              null as unknown as ReviewData
            )
            if (!review) throw new Error("Review not found")
            if (body.active !== undefined) review.active = body.active
            if (body.title !== undefined) review.title = body.title
            await writeJsonFile(filePath, review)
            return review
          }),
        catch: (cause) =>
          new FSError({ path: filePath, op: "write", cause }),
      })
      return ok({
        review: {
          id: updated.id,
          title: updated.title,
          active: updated.active,
        },
      })
    })
)

export const DELETE = dynamicHandler<Params, NotFoundError | FSError>(
  (_req, { id }) =>
    Effect.gen(function* () {
      const filePath = getReviewFilePath(id)
      if (!existsSync(filePath)) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "review", id })
        )
      }
      yield* Effect.tryPromise({
        try: () => unlink(filePath),
        catch: (cause) =>
          new FSError({ path: filePath, op: "rm", cause }),
      })
      return ok({ success: true })
    })
)
