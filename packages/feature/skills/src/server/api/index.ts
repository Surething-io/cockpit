/**
 * /api/skills — P8+ migration (GET list + POST add)
 */
import { Effect } from "effect"
import {
  SKILLS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { parseSkillMd } from "../lib/parseSkillMd"

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

function makeId(): string {
  return `skill-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      try: () => readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => DEFAULT))

    const enriched = yield* Effect.promise(() =>
      Promise.all(
        (data.skills || []).map(async (s) => {
          const parsed = await parseSkillMd(s.path)
          return {
            id: s.id,
            path: s.path,
            addedAt: s.addedAt,
            name: parsed.name,
            description: parsed.description,
            icon: parsed.icon,
            argumentHint: parsed.argumentHint,
            valid: parsed.valid,
          }
        })
      )
    )
    return ok(enriched)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { path?: unknown }
    if (typeof body.path !== "string" || !body.path.trim()) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }
    const trimmed = body.path.trim()
    if (!trimmed.startsWith("/")) {
      return yield* Effect.fail(
        new ValidationError({
          field: "path",
          reason: "must be absolute",
        })
      )
    }

    const parsed = yield* Effect.tryPromise({
      try: () => parseSkillMd(trimmed),
      catch: (cause) =>
        new FSError({ path: trimmed, op: "read", cause }),
    })
    if (!parsed.valid) {
      return yield* Effect.fail(
        new ValidationError({
          field: "path",
          reason: "File does not exist or cannot be read",
        })
      )
    }

    const record = yield* Effect.tryPromise({
      try: () =>
        withFileLock(SKILLS_FILE, async () => {
          const data = await readJsonFile<SkillsFile>(SKILLS_FILE, DEFAULT)
          const existing = data.skills.find((s) => s.path === trimmed)
          if (existing) return existing
          const next: SkillRecord = {
            id: makeId(),
            path: trimmed,
            addedAt: new Date().toISOString(),
          }
          await writeJsonFile(SKILLS_FILE, {
            skills: [...data.skills, next],
          })
          return next
        }),
      catch: (cause) =>
        new FSError({ path: SKILLS_FILE, op: "write", cause }),
    })

    return ok({
      id: record.id,
      path: record.path,
      addedAt: record.addedAt,
      name: parsed.name,
      description: parsed.description,
      icon: parsed.icon,
      argumentHint: parsed.argumentHint,
      valid: true,
    })
  })
)
