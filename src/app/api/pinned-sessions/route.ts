/**
 * /api/pinned-sessions — P6 migration
 *
 * JSON file CRUD template (similar to /api/projects):
 * - GET reads ~/.cockpit/pinned-sessions.json; on failure falls back to an empty array
 * - POST writes (validate body shape via ValidationError)
 */
import { Effect } from "effect"
import {
  PINNED_SESSIONS_FILE,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export interface PinnedSession {
  sessionId: string
  cwd: string
  customTitle?: string
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const sessions = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<PinnedSession[]>(PINNED_SESSIONS_FILE, []),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => [] as PinnedSession[]))
    return ok({ sessions })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { sessions?: PinnedSession[] }
    if (!Array.isArray(body.sessions)) {
      return yield* Effect.fail(
        new ValidationError({ field: "sessions", reason: "must be array" })
      )
    }
    yield* Effect.tryPromise({
      try: () => writeJsonFile(PINNED_SESSIONS_FILE, body.sessions),
      catch: (cause) =>
        new FSError({
          path: PINNED_SESSIONS_FILE,
          op: "write",
          cause,
        }),
    })
    return ok({ success: true })
  })
)
