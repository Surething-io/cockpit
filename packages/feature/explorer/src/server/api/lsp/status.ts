/**
 * /api/lsp/status — P8+ migration
 */
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError } from "@cockpit/effect-core"
import { getStatus } from "@cockpit/feature-explorer/server/lsp/LSPServerRegistry"

export const GET = handler(() =>
  Effect.gen(function* () {
    const servers = yield* Effect.try({
      try: () => getStatus(),
      catch: (cause) =>
        new AppError({ message: "Failed to get LSP status", cause }),
    })
    return ok({ servers })
  })
)
