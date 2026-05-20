/**
 * /api/version — P6 migration
 *
 * Returns the cockpit package version (read from COCKPIT_ROOT/package.json).
 */
import { readFileSync } from "fs"
import { join } from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"

export const runtime = "nodejs"

export const GET = handler(() =>
  Effect.gen(function* () {
    const root = process.env.COCKPIT_ROOT || process.cwd()
    const version = yield* Effect.try({
      try: () => {
        const pkg = JSON.parse(
          readFileSync(join(root, "package.json"), "utf-8")
        ) as { version?: string }
        return pkg.version ?? ""
      },
      // Return empty version on missing file / parse failure (v1 behavior)
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ""))

    return ok({ version })
  })
)
