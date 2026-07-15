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
  (req, { id }) =>
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
      // Closed sharing must revoke viewing for remote/LAN viewers: a deactivated
      // review is treated as not found, so previously-copied /review/{id} links
      // stop working too. The LOCAL admin is exempt — the server stamps an
      // unforgeable `x-cockpit-local: 1` header (loopback peer, no forwarding
      // header) so the owner can still inspect / re-open a closed review.
      if (review.active === false) {
        const isLocalAdmin =
          req.headers.get("x-cockpit-local") === "1"
        if (!isLocalAdmin) {
          return yield* Effect.fail(
            new NotFoundError({ resource: "review", id })
          )
        }
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
