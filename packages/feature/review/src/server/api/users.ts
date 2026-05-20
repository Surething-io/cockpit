/**
 * /api/review/users — P8+ migration
 */
import { join } from "path"
import { Effect } from "effect"
import {
  REVIEW_DIR,
  readJsonFile,
  writeJsonFile,
  withFileLock,
  ensureDir,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

const USERS_FILE = join(REVIEW_DIR, "_users.json")

interface UserRecord {
  name: string
  confirmedAt: number
}
type UsersMap = Record<string, UserRecord>

export const GET = handler(() =>
  Effect.gen(function* () {
    const users = yield* Effect.tryPromise({
      try: async () => {
        await ensureDir(REVIEW_DIR)
        return await readJsonFile<UsersMap>(USERS_FILE, {})
      },
      catch: (cause) =>
        new FSError({ path: USERS_FILE, op: "read", cause }),
    })
    return ok({ users })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      authorId?: string
      name?: string
    }
    if (!body.authorId || !body.name) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.authorId ? "authorId" : "name",
          reason: "missing",
        })
      )
    }
    const { authorId, name } = body
    const updated = yield* Effect.tryPromise({
      try: async () => {
        await ensureDir(REVIEW_DIR)
        return await withFileLock(USERS_FILE, async () => {
          const users = await readJsonFile<UsersMap>(USERS_FILE, {})
          users[authorId] = {
            name: name.trim(),
            confirmedAt: Date.now(),
          }
          await writeJsonFile(USERS_FILE, users)
          return users
        })
      },
      catch: (cause) =>
        new FSError({ path: USERS_FILE, op: "write", cause }),
    })
    return ok({ users: updated })
  })
)
