/**
 * /api/bots/files — a Bot's directory, for the Bots board's file tree.
 *
 *   GET ?id=<botId>              → { dir, files: [{ path, size }], truncated }
 *   GET ?id=<botId>&path=<rel>   → { path, kind, content?, size }
 *
 * The directory comes from the registry (built-ins included), never from the
 * client; reads are confined to it (@cockpit/shared-utils/dirFiles). Same shape
 * as /api/skills/files, so the board renders both with one component.
 */
import { Effect } from "effect"
import { NotFoundError, ValidationError } from "@cockpit/effect-core"
import { BotRegistryService } from "@cockpit/effect-services"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { listDirFiles, readFileWithin } from "@cockpit/shared-utils/dirFiles"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const params = new URL(req.url).searchParams
    const id = params.get("id")
    if (!id) return yield* Effect.fail(new ValidationError({ field: "id", reason: "missing" }))
    const registry = yield* BotRegistryService
    const bot = (yield* registry.list).find((b) => b.id === id)
    if (!bot) return yield* Effect.fail(new NotFoundError({ resource: "bot", id }))
    const dir = bot.path

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
    if (read.kind === "outside") return yield* Effect.fail(new ValidationError({ field: "path", reason: "outside bot directory" }))
    if (read.kind === "missing") return yield* Effect.fail(new NotFoundError({ resource: "file", id: rel }))
    return ok({ path: rel, ...read })
  }),
)
