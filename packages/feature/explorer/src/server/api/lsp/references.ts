/**
 * /api/lsp/references — P8+ migration
 */
import { readFile } from "fs/promises"
import { resolve } from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"
import { getLanguageForFile } from "@cockpit/feature-explorer/server/lsp/types"
import {
  getOrCreateServer,
  ensureFileOpen,
} from "@cockpit/feature-explorer/server/lsp/LSPServerRegistry"

interface LspBody {
  cwd?: string
  filePath?: string
  line?: number
  column?: number
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as LspBody
    if (!body.filePath || !body.line || !body.column) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.filePath
            ? "filePath"
            : !body.line
              ? "line"
              : "column",
          reason: "missing",
        })
      )
    }
    const { cwd, filePath, line, column } = body

    const language = getLanguageForFile(filePath)
    if (!language) return ok({ references: [] })

    const projectCwd = cwd || process.cwd()
    const server = yield* Effect.tryPromise({
      try: () => getOrCreateServer(language, projectCwd),
      catch: (cause) =>
        new AppError({ message: "LSP server startup failed", cause }),
    })
    if (!server) return ok({ references: [] })

    const absPath = resolve(projectCwd, filePath)
    yield* Effect.tryPromise({
      try: async () => {
        const content = await readFile(absPath, "utf-8")
        await ensureFileOpen(server, absPath, content)
      },
      catch: (cause) =>
        new ValidationError({
          field: "filePath",
          reason: `cannot read file: ${String(cause)}`,
        }),
    })

    const references = yield* Effect.tryPromise({
      try: () => server.adapter.references(absPath, line, column),
      catch: (cause) =>
        new AppError({ message: "LSP references failed", cause }),
    })

    return ok({ references })
  })
)
