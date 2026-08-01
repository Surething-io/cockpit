/**
 * /api/prompts/config — quick prompts for the chat input.
 *
 * Two scopes, same shape, mirroring /api/services/config:
 *   global  → ~/.cockpit/prompts.json
 *   project → ~/.cockpit/projects/<encoded cwd>/prompts.json
 *
 * A quick prompt is just its text — unlike a Console quick command it is never
 * addressed by name (the chat input's `/` and `@` markers already belong to
 * slash commands and skills), so a `name` field would be display-only clutter
 * the user has to fill in for every entry.
 */
import { Effect } from "effect"
import {
  getPromptsConfigPath,
  getGlobalPromptsConfigPath,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

// NOTE: `runtime` / `dynamic` live in the route shim
// (src/app/api/prompts/config/route.ts), not here — Next only picks them up by
// static analysis of the route file, so declaring them in this module would be
// a config that looks set but never applies.

interface PromptsConfig {
  prompts: string[]
}

/** Longest single prompt kept. Well past "one-liner"; guards against a paste
 *  of a whole document turning the popover into an unusable wall of text. */
const MAX_PROMPT_LENGTH = 2000

/**
 * Coerce arbitrary on-disk data into a valid string[]. Never throws.
 *
 * Non-strings are dropped rather than String()-ed: a stray `null` rendered as
 * "null" would be a sendable prompt the user never wrote. Exact duplicates are
 * collapsed because two identical rows are indistinguishable in the popover —
 * the second one is unclickable noise.
 */
export const normalizePrompts = (raw: unknown): string[] => {
  if (!Array.isArray(raw)) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const entry of raw) {
    if (typeof entry !== "string") continue
    const prompt = entry.trim().slice(0, MAX_PROMPT_LENGTH)
    if (!prompt || seen.has(prompt)) continue
    seen.add(prompt)
    out.push(prompt)
  }
  return out
}

const resolveConfigPath = (
  cwd: string | null,
  scope: string | null
): string | null =>
  scope === "global"
    ? getGlobalPromptsConfigPath()
    : cwd
      ? getPromptsConfigPath(cwd)
      : null

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const configPath = resolveConfigPath(sp.get("cwd"), sp.get("scope"))
    if (!configPath) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd|scope", reason: "Missing cwd or scope" })
      )
    }
    const raw = yield* Effect.tryPromise({
      try: () => readJsonFile<Partial<PromptsConfig>>(configPath, { prompts: [] }),
      catch: (cause) => new FSError({ path: configPath, op: "read", cause }),
    })
    // Normalized in memory only — deliberately NOT written back. A read with a
    // write side effect races a concurrent POST (neither takes the file lock)
    // and could resurrect a prompt the user just deleted.
    return ok({ prompts: normalizePrompts(raw?.prompts) })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      scope?: string
      prompts?: string[]
    }
    const configPath = resolveConfigPath(body.cwd ?? null, body.scope ?? null)
    if (!configPath) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd|scope", reason: "Missing cwd or scope" })
      )
    }
    // Full-array overwrite: add / edit / delete / reorder all post the whole
    // list, so ordering is simply the array's — there is no order field to
    // drift out of sync with it.
    const config: PromptsConfig = { prompts: normalizePrompts(body.prompts) }
    // withFileLock, not a bare writeJsonFile: the latter truncates then writes,
    // so an unserialized concurrent reader can observe a half-written file.
    yield* Effect.tryPromise({
      try: () => withFileLock(configPath, () => writeJsonFile(configPath, config)),
      catch: (cause) => new FSError({ path: configPath, op: "write", cause }),
    })
    // Echo what was actually persisted. This POST is the authoritative
    // normalization point (trims, drops empties, collapses duplicates), so a
    // caller keeping its optimistic array would silently disagree with disk.
    return ok({ success: true, prompts: config.prompts })
  })
)
