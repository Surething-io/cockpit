/**
 * /api/skills/builtin — the builtin skills, for the skills board's "Builtin"
 * group. Read-only: they ship with the package and cannot be added or removed.
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { listBuiltinSkills } from "../lib/builtinSkillsList"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler(() =>
  Effect.gen(function* () {
    const skills = yield* Effect.tryPromise(() => listBuiltinSkills()).pipe(
      Effect.orElseSucceed(() => [])
    )
    // Same row shape as /api/skills, minus the full content.
    return ok(
      skills.map(({ id, path, name, description, icon, argumentHint, valid }) => ({
        id, path, name, description, icon, argumentHint, valid, addedAt: "",
      }))
    )
  })
)
