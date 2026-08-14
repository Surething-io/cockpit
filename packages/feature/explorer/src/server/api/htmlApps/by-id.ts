/**
 * /api/html-apps/[id] — remove an entry from the HTML-apps registry (DELETE).
 *
 * Uses `dynamicHandler`, which supports the Next.js (req, ctx) dynamic-params
 * signature. The previous hand-rolled wrapping here serialised the whole error
 * object as `{ error: <object> }`, which renders as '[object Object]' client
 * side — the exact regression documented in effect-runtime/next.ts.
 */
import { Effect } from "effect"
import {
  HTML_APPS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { dynamicHandler, ok } from "@cockpit/effect-runtime/server"
import { FSError, NotFoundError, ValidationError } from "@cockpit/effect-core"
import { isBuiltinId } from "./builtins"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface HtmlAppRecord {
  id: string
  path: string
  addedAt: string
}
interface HtmlAppsFile {
  apps: HtmlAppRecord[]
}
const DEFAULT: HtmlAppsFile = { apps: [] }

export const DELETE = dynamicHandler<
  { id: string },
  ValidationError | FSError | NotFoundError
>((_req, { id }) =>
  Effect.gen(function* () {
    if (!id) {
      return yield* Effect.fail(
        new ValidationError({ field: "id", reason: "missing" })
      )
    }
    // Built-in cards are virtual — they live in no file, so there is nothing
    // to remove. The UI hides their delete button; this guards the endpoint.
    if (isBuiltinId(id)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "id",
          reason: "built-in apps cannot be removed",
        })
      )
    }
    const removed = yield* Effect.tryPromise({
      try: () =>
        withFileLock(HTML_APPS_FILE, async () => {
          const data = await readJsonFile<HtmlAppsFile>(HTML_APPS_FILE, DEFAULT)
          const next = data.apps.filter((a) => a.id !== id)
          if (next.length === data.apps.length) return false
          await writeJsonFile(HTML_APPS_FILE, { apps: next })
          return true
        }),
      catch: (cause) => new FSError({ path: HTML_APPS_FILE, op: "write", cause }),
    })
    if (!removed) {
      return yield* Effect.fail(new NotFoundError({ resource: "html-app", id }))
    }
    return ok({ success: true })
  })
)
