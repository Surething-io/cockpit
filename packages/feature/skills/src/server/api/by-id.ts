/**
 * /api/skills/[id] — P8+ migration (DELETE)
 *
 * Uses `dynamicHandler`, which supports the Next.js (req, ctx) signature the
 * old BACKLOG note was waiting on. The hand-rolled wrapping it replaced
 * serialised the whole error object as `{ error: <object> }`, which renders as
 * '[object Object]' client side — see effect-runtime/next.ts.
 */
import { Effect } from "effect"
import {
  SKILLS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { dynamicHandler, ok } from "@cockpit/effect-runtime/server"
import { FSError, NotFoundError, ValidationError } from "@cockpit/effect-core"

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
    const removed = yield* Effect.tryPromise({
      try: () =>
        withFileLock(SKILLS_FILE, async () => {
          const data = await readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT)
          const next = data.skills.filter((s) => s.id !== id)
          if (next.length === data.skills.length) return false
          await writeJsonFile(SKILLS_FILE, { skills: next })
          return true
        }),
      catch: (cause) => new FSError({ path: SKILLS_FILE, op: "write", cause }),
    })
    if (!removed) {
      return yield* Effect.fail(new NotFoundError({ resource: "skill", id }))
    }
    return ok({ success: true })
  })
)
