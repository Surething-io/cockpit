/**
 * /api/skills/content — P8+ migration
 */
import { Effect } from "effect"
import { SKILLS_FILE, readJsonFile } from "@cockpit/shared-utils"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  FSError,
  NotFoundError,
  ValidationError,
} from "@cockpit/effect-core"
import { parseSkillMd } from "../lib/parseSkillMd"
import { BUILTIN_ID_PREFIX, builtinSkillFile } from "../lib/builtinSkillsList"

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

export const GET = handler((req) =>
  Effect.gen(function* () {
    const id = new URL(req.url).searchParams.get("id")
    if (!id) {
      return yield* Effect.fail(
        new ValidationError({ field: "id", reason: "missing" })
      )
    }
    // Builtin (`builtin:<cmd>`, see builtinSkillsList): read straight from the
    // package's skills/ directory. The command name is constrained to a plain
    // directory name so the id cannot walk out of it.
    if (id.startsWith(BUILTIN_ID_PREFIX)) {
      const cmd = id.slice(BUILTIN_ID_PREFIX.length)
      if (!/^[A-Za-z0-9_-]+$/.test(cmd)) {
        return yield* Effect.fail(new ValidationError({ field: "id", reason: "invalid" }))
      }
      const path = builtinSkillFile(cmd)
      const parsed = yield* Effect.tryPromise({
        try: () => parseSkillMd(path),
        catch: (cause) => new FSError({ path, op: "read", cause }),
      })
      if (!parsed.valid) {
        return yield* Effect.fail(new NotFoundError({ resource: "skill", id }))
      }
      return ok({ id, path, ...parsed, name: cmd })
    }

    const data = yield* Effect.tryPromise({
      try: () => readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT),
      catch: (cause) =>
        new FSError({ path: SKILLS_FILE, op: "read", cause }),
    })
    const record = data.skills.find((s) => s.id === id)
    if (!record) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "skill", id })
      )
    }
    const parsed = yield* Effect.tryPromise({
      try: () => parseSkillMd(record.path),
      catch: (cause) =>
        new FSError({ path: record.path, op: "read", cause }),
    })
    return ok({
      id: record.id,
      path: record.path,
      name: parsed.name,
      description: parsed.description,
      icon: parsed.icon,
      argumentHint: parsed.argumentHint,
      valid: parsed.valid,
      content: parsed.content,
    })
  })
)
