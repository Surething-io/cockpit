/**
 * /api/lsp/warmup — P8+ migration
 *
 * Non-blocking warmup: spawn LSP server + pre-open file; failures return { ok: false }.
 */
import { readFile } from "fs/promises"
import { resolve } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { getLanguageForFile } from "@cockpit/feature-explorer/server/lsp/types"
import {
  getOrCreateServer,
  ensureFileOpen,
} from "@cockpit/feature-explorer/server/lsp/LSPServerRegistry"

interface WarmupBody {
  cwd?: string
  filePath?: string
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as WarmupBody
    if (!body.filePath) return ok({ ok: false })

    const language = getLanguageForFile(body.filePath)
    if (!language) return ok({ ok: false })

    const projectCwd = body.cwd || process.cwd()
    const server = yield* Effect.tryPromise({
      try: () => getOrCreateServer(language, projectCwd),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))

    if (!server) return ok({ ok: false })

    // Pre-open the file; failure does not affect the overall response
    const absPath = resolve(projectCwd, body.filePath)
    yield* Effect.tryPromise({
      try: async () => {
        const content = await readFile(absPath, "utf-8")
        await ensureFileOpen(server, absPath, content)
      },
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => null))

    return ok({ ok: true, language, pid: server.process.pid })
  })
)
