/**
 * /api/skills/files — a skill's directory, for the skills board's file tree.
 *
 *   GET ?id=<skillId>              → { dir, files: [{ path, size }], truncated }
 *   GET ?id=<skillId>&path=<rel>   → { path, kind, content?, size }
 *
 * `kind` is "text" (content included), "binary" or "tooLarge" (listed, not
 * served). Paths are relative to the skill directory and confined to it
 * (shared-utils/dirFiles).
 */
import nodePath from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { NotFoundError, ValidationError } from "@cockpit/effect-core"
import { listDirFiles, readFileWithin } from "@cockpit/shared-utils/dirFiles"
import { skillMdPathById } from "../lib/skillFiles"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const params = new URL(req.url).searchParams
    const id = params.get("id")
    if (!id) return yield* Effect.fail(new ValidationError({ field: "id", reason: "missing" }))
    const skillMd = yield* Effect.tryPromise(() => skillMdPathById(id)).pipe(Effect.orElseSucceed(() => null))
    if (!skillMd) return yield* Effect.fail(new NotFoundError({ resource: "skill", id }))
    const dir = nodePath.dirname(skillMd)

    const rel = params.get("path")
    if (rel === null) {
      const listing = yield* Effect.tryPromise(() => listDirFiles(dir)).pipe(
        Effect.orElseSucceed(() => ({ files: [], truncated: false })),
      )
      return ok({ dir, ...listing })
    }

    const read = yield* Effect.tryPromise(() => readFileWithin(dir, rel)).pipe(
      Effect.orElseSucceed(() => ({ kind: "missing" as const })),
    )
    if (read.kind === "outside") return yield* Effect.fail(new ValidationError({ field: "path", reason: "outside skill directory" }))
    if (read.kind === "missing") return yield* Effect.fail(new NotFoundError({ resource: "file", id: rel }))
    return ok({ path: rel, ...read })
  }),
)
