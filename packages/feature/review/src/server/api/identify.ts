/**
 * /api/review/identify — P8+ migration
 *
 * MAC → authorId identification + nickname binding.
 */
import { networkInterfaces } from "os"
import { join } from "path"
import { Effect } from "effect"
import { getMacByIp, macToAuthorId } from "../lib/arp"
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
type UsersMap = Record<string, { name: string; confirmedAt: number }>

function getLocalMac(): string | null {
  const interfaces = networkInterfaces()
  for (const iface of Object.values(interfaces)) {
    for (const alias of iface || []) {
      if (
        alias.family === "IPv4" &&
        !alias.internal &&
        alias.mac &&
        alias.mac !== "00:00:00:00:00:00"
      ) {
        return alias.mac.toLowerCase()
      }
    }
  }
  return null
}

function resolveAuthorId(request: Request): string | null {
  const forwarded = request.headers.get("x-forwarded-for")
  const ip =
    forwarded?.split(",")[0].trim() ||
    request.headers.get("x-real-ip") ||
    ""

  if (
    !ip ||
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip === "localhost"
  ) {
    const localMac = getLocalMac()
    return localMac ? macToAuthorId(localMac) : null
  }

  const cleanIp = ip.replace(/^::ffff:/, "")
  const mac = getMacByIp(cleanIp)
  return mac ? macToAuthorId(mac) : null
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const authorId = resolveAuthorId(req)
    if (!authorId) {
      return ok({ authorId: null, name: null })
    }
    const users = yield* Effect.tryPromise({
      try: async () => {
        await ensureDir(REVIEW_DIR)
        return await readJsonFile<UsersMap>(USERS_FILE, {})
      },
      catch: (cause) =>
        new FSError({ path: USERS_FILE, op: "read", cause }),
    })
    return ok({ authorId, name: users[authorId]?.name || null })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { name?: string }
    const authorId = resolveAuthorId(req)
    if (!authorId || !body.name?.trim()) {
      return yield* Effect.fail(
        new ValidationError({
          field: !authorId ? "authorId" : "name",
          reason: "Cannot identify device or missing name",
        })
      )
    }
    const trimmedName = body.name.trim()
    yield* Effect.tryPromise({
      try: async () => {
        await ensureDir(REVIEW_DIR)
        await withFileLock(USERS_FILE, async () => {
          const users = await readJsonFile<UsersMap>(USERS_FILE, {})
          users[authorId] = {
            name: trimmedName,
            confirmedAt: Date.now(),
          }
          await writeJsonFile(USERS_FILE, users)
        })
      },
      catch: (cause) =>
        new FSError({ path: USERS_FILE, op: "write", cause }),
    })
    return ok({ authorId, name: trimmedName })
  })
)
