/**
 * /api/skills/[id] — P8+ migration (DELETE)
 *
 * The Next.js dynamic-params signature is incompatible with the handler template — hand-rolled Effect wrapping is used.
 * (BACKLOG: switch back once handler supports the (req, ctx) signature.)
 */
import { Cause, Effect, Exit, Option } from "effect"
import {
  SKILLS_FILE,
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

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface SkillRecord {
  id: string
  path: string
  addedAt: string
}
interface SkillsFile {
  skills: SkillRecord[]
}
const DEFAULT: SkillsFile = { skills: [] }

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
  return new Response(
    JSON.stringify({ error: { _tag: "InternalError" } }),
    {
      status: 500,
      headers: { "Content-Type": "application/json" },
    }
  )
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
      const removed = yield* Effect.tryPromise({
        try: () =>
          withFileLock(SKILLS_FILE, async () => {
            const data = await readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT)
            const next = data.skills.filter((s) => s.id !== id)
            if (next.length === data.skills.length) return false
            await writeJsonFile(SKILLS_FILE, { skills: next })
            return true
          }),
        catch: (cause) =>
          new FSError({ path: SKILLS_FILE, op: "write", cause }),
      })
      if (!removed) {
        return yield* Effect.fail(
          new NotFoundError({ resource: "skill", id })
        )
      }
      return okResp({ success: true })
    })
  )

  return Exit.match(exit, {
    onSuccess: (res) => res,
    onFailure: (cause) => failResp(cause as Cause.Cause<unknown>),
  })
}
