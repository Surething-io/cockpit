/**
 * Client-side LSP IO — Effect wrappers
 *
 * Wraps the 4 POST calls in useLSP (definition / hover / references / warmup).
 * All four endpoints share the same shape: `{cwd, filePath, line, column}` body,
 * returning `{definitions} | {hover} | {references}`.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"
import type { Location, HoverInfo } from "@cockpit/feature-explorer/server/lsp/types"

interface LspBody {
  cwd: string
  filePath: string
  line: number
  column: number
}

const lspPost = <A>(
  endpoint: string,
  body: unknown
): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(endpoint, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return (await res.json()) as A
    },
    catch: (cause) =>
      new AppError({ message: `${endpoint} failed`, cause }),
  })

/** POST /api/lsp/definition */
export const lspDefinition = (
  body: LspBody
): Effect.Effect<{ definitions?: ReadonlyArray<Location> }, AppError> =>
  lspPost("/api/lsp/definition", body)

/** POST /api/lsp/hover */
export const lspHover = (
  body: LspBody
): Effect.Effect<{ hover?: HoverInfo }, AppError> =>
  lspPost("/api/lsp/hover", body)

/** POST /api/lsp/references */
export const lspReferences = (
  body: LspBody
): Effect.Effect<{ references?: ReadonlyArray<Location> }, AppError> =>
  lspPost("/api/lsp/references", body)

/** POST /api/lsp/warmup — fire-and-forget */
export const lspWarmup = (
  body: Pick<LspBody, "cwd" | "filePath">
): Effect.Effect<void, AppError> =>
  lspPost<unknown>("/api/lsp/warmup", body).pipe(Effect.asVoid)
