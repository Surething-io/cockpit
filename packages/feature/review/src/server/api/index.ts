/**
 * /api/review — P8+ migration (list + create)
 */
import { readdir } from "fs/promises"
import { join } from "path"
import { Effect } from "effect"
import {
  REVIEW_DIR,
  getReviewFilePath,
  readJsonFile,
  writeJsonFile,
  ensureDir,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { generateReviewId, ReviewData } from "../lib/reviewUtils"

const ORDER_FILE = join(REVIEW_DIR, "_order.json")

export const GET = handler(() =>
  Effect.gen(function* () {
    const list = yield* Effect.tryPromise({
      try: async () => {
        await ensureDir(REVIEW_DIR)
        const files = await readdir(REVIEW_DIR)
        const jsonFiles = files.filter(
          (f) => f.endsWith(".json") && !f.startsWith("_")
        )

        const reviews: Array<{
          id: string
          title: string
          active: boolean
          createdAt: number
          updatedAt?: number
          commentCount: number
          lastCommentAt?: number
          sourceFile?: string
        }> = []

        for (const file of jsonFiles) {
          const id = file.replace(".json", "")
          const data = await readJsonFile<ReviewData>(
            getReviewFilePath(id),
            null as unknown as ReviewData
          )
          if (data) {
            let lastCommentAt: number | undefined
            for (const c of data.comments) {
              if (!lastCommentAt || c.createdAt > lastCommentAt)
                lastCommentAt = c.createdAt
              for (const r of c.replies) {
                if (!lastCommentAt || r.createdAt > lastCommentAt)
                  lastCommentAt = r.createdAt
              }
            }
            reviews.push({
              id: data.id,
              title: data.title,
              active: data.active,
              createdAt: data.createdAt,
              updatedAt: data.updatedAt,
              commentCount: data.comments.length,
              lastCommentAt,
              sourceFile: data.sourceFile,
            })
          }
        }

        const order = await readJsonFile<string[]>(ORDER_FILE, [])
        if (order.length > 0) {
          const orderMap = new Map(order.map((id, i) => [id, i]))
          const ordered = reviews.filter((r) => orderMap.has(r.id))
          const unordered = reviews.filter((r) => !orderMap.has(r.id))
          ordered.sort((a, b) => orderMap.get(a.id)! - orderMap.get(b.id)!)
          unordered.sort((a, b) => b.createdAt - a.createdAt)
          return [...ordered, ...unordered]
        }
        reviews.sort((a, b) => b.createdAt - a.createdAt)
        return reviews
      },
      catch: (cause) =>
        new FSError({ path: REVIEW_DIR, op: "read", cause }),
    })
    return ok({ reviews: list })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      title?: string
      content?: string
      sourceFile?: string
    }
    if (!body.title || body.content === undefined || !body.sourceFile) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.title
            ? "title"
            : body.content === undefined
              ? "content"
              : "sourceFile",
          reason: "missing",
        })
      )
    }
    const { title, content, sourceFile } = body

    const review = yield* Effect.tryPromise({
      try: async () => {
        await ensureDir(REVIEW_DIR)
        const id = generateReviewId(sourceFile)
        const filePath = getReviewFilePath(id)
        const existing = await readJsonFile<ReviewData>(
          filePath,
          null as unknown as ReviewData
        )
        if (existing) {
          existing.content = content
          existing.title = title
          existing.active = true
          existing.updatedAt = Date.now()
          await writeJsonFile(filePath, existing)
          return {
            id: existing.id,
            title: existing.title,
            active: existing.active,
            createdAt: existing.createdAt,
            updatedAt: existing.updatedAt,
            existing: true,
          }
        }
        const now = Date.now()
        const data: ReviewData = {
          id,
          title,
          content,
          sourceFile,
          active: true,
          createdAt: now,
          updatedAt: now,
          comments: [],
        }
        await writeJsonFile(filePath, data)
        return {
          id,
          title,
          active: true,
          createdAt: data.createdAt,
          updatedAt: data.updatedAt,
        }
      },
      catch: (cause) =>
        new FSError({ path: REVIEW_DIR, op: "write", cause }),
    })

    return ok({ review })
  })
)
