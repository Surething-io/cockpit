/**
 * /api/html-apps/[id] — remove an entry from the HTML-apps registry (DELETE).
 *
 * The Next.js dynamic-params signature is incompatible with the handler
 * template — hand-rolled Effect wrapping (mirrors /api/skills/[id]).
 */
import { Cause, Effect, Exit, Option } from "effect"
import {
  HTML_APPS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { AppRuntime } from "@cockpit/effect-runtime/server"
import {
  FSError,
  NotFoundError,
  ValidationError,
  errorToStatus,
  type CockpitError,
} from "@cockpit/effect-core"
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

const okResp = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })

const failResp = (cause: Cause.Cause<unknown>): Response => {
  const failure = Cause.failureOption(cause)
  if (Option.isSome(failure)) {
    const e = failure.value as CockpitError
    return new Response(JSON.stringify({ error: e }), {
      status: errorToStatus(e),
      headers: { "Content-Type": "application/json" },
    })
  }
  return new Response(JSON.stringify({ error: { _tag: "InternalError" } }), {
    status: 500,
    headers: { "Content-Type": "application/json" },
  })
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> }
): Promise<Response> {
  const { id } = await params

  const exit = await AppRuntime.runPromiseExit(
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
          new ValidationError({ field: "id", reason: "built-in apps cannot be removed" })
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
      return okResp({ success: true })
    })
  )

  return Exit.match(exit, {
    onSuccess: (res) => res,
    onFailure: (cause) => failResp(cause as Cause.Cause<unknown>),
  })
}
