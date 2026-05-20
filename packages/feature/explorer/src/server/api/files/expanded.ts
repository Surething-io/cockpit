/**
 * /api/files/expanded — P8+ migration
 */
import { Effect } from "effect"
import {
  getExpandedPathsPath,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const filePath = getExpandedPathsPath(cwd)
    const paths = yield* Effect.tryPromise({
      try: () => readJsonFile<string[]>(filePath, []),
      catch: (cause) => new FSError({ path: filePath, op: "read", cause }),
    })
    return ok({ paths })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      paths?: string[]
    }
    if (!body.cwd || !Array.isArray(body.paths)) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "paths",
          reason: "missing or invalid",
        })
      )
    }
    const filePath = getExpandedPathsPath(body.cwd)
    yield* Effect.tryPromise({
      try: () => writeJsonFile(filePath, body.paths),
      catch: (cause) => new FSError({ path: filePath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
