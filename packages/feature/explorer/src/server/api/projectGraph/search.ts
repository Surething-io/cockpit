import { indexResponse } from "./indexResponse"
import { indexQueryError } from "@cockpit/feature-explorer/server/codeMap/projectGraph/indexFiles"
/**
 * /api/projectGraph/search — P8+ migration
 *
 * Query params:
 *   cwd              — absolute project path (validated)
 *   q                — search query; separator/case-folded before
 *                      matching, so `user_profile` / `userProfile` /
 *                      `user-profile` / `USER_PROFILE` all hit the
 *                      same indexed names
 *   limit            — per-category cap (1–500, default 50)
 *   path             — project-relative directory, including descendants
 *   excludeTests     — true/1 excludes test files from every category
 *   Ranking          — raw exact, normalized exact, prefix, then substring;
 *                      all eligible candidates are scanned before selection
 *   includeLiterals  — when "true"/"1", also search identifier-shaped
 *                      string literals harvested from source. Surfaces
 *                      tool names / event names / config keys / route
 *                      paths that live only as string literals (e.g.
 *                      `name: "user_profile"`) and would otherwise be
 *                      invisible to symbol-only search. Off by default
 *                      to keep Cmd+K palette responses lean.
 */
import { Effect } from "effect"
import {
  getCodeIndex,
  searchIndex,
} from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import { relativeQueryPath } from "../../codeMap/projectGraph/queryFilters"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

function parseBool(v: string | null): boolean {
  if (!v) return false
  const s = v.toLowerCase()
  return s === "true" || s === "1" || s === "yes"
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const q = sp.get("q") ?? ""
    const limit = Math.min(
      Math.max(parseInt(sp.get("limit") ?? "50", 10) || 50, 1),
      500
    )
    const includeLiterals = parseBool(sp.get("includeLiterals"))
    const filters = yield* Effect.try({
      try: () => {
        const directory = relativeQueryPath(sp.get("path") ?? ".", "path")
        const excludeTests = sp.get("excludeTests") ?? "false"
        if (!["true", "false", "1", "0"].includes(excludeTests)) {
          throw new ValidationError({ field: "excludeTests", reason: "Expected true, false, 1 or 0" })
        }
        return { directory, excludeTests: excludeTests === "true" || excludeTests === "1" }
      },
      catch: cause => indexQueryError(cause, "Invalid search filters"),
    })
    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason })
      )
    }
    const cwd = cwdCheck.abs
    if (q.trim().length < 1) {
      return ok(
        includeLiterals
          ? { files: [], symbols: [], literals: [] }
          : { files: [], symbols: [] }
      )
    }
    const result = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd)
        return indexResponse(index, searchIndex(index, q, limit, { includeLiterals, ...filters }))
      },
      catch: (cause) =>
        indexQueryError(cause, "Search failed"),
    })
    return result
  })
)
