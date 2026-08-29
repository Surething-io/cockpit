/**
 * /api/projectGraph/coedit — Files frequently changed alongside a target.
 *
 * Returns two arrays: `history` (from git log, past co-edits) and
 * `uncommitted` (from git status, current working-tree co-edits). Together
 * they expose "conventional coupling" — files that have to be edited together
 * even though no static syntax edge connects them. Canonical example in
 * cockpit: a shipped asset dir resolved in paths.ts (APPS_DIR /
 * BUILTIN_SKILLS_SRC_DIR) ↔ the same dir listed in `package.json#files`, with
 * no import linking them.
 *
 * Query params:
 *   cwd       — absolute project path (validated)
 *   filePath  — project-relative path of the target file
 *   commits   — optional, history scan window. Default 100, max 1000.
 */
import { Effect } from "effect"
import { coEditFromGit } from "@cockpit/feature-explorer/server/codeMap/projectGraph/coedit"
import { validateCwd } from "@cockpit/feature-explorer/server/files/shared"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const filePath = sp.get("filePath") ?? ""
    const commits = Math.min(
      Math.max(parseInt(sp.get("commits") ?? "100", 10) || 100, 1),
      1000
    )

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason })
      )
    }
    if (filePath.trim().length < 1) {
      return yield* Effect.fail(
        new ValidationError({ field: "filePath", reason: "missing" })
      )
    }
    const cwd = cwdCheck.abs

    const result = yield* Effect.tryPromise({
      try: () => coEditFromGit(cwd, filePath, commits),
      catch: (cause) =>
        new AppError({ message: "Co-edit lookup failed", cause }),
    })
    return ok(result)
  })
)
