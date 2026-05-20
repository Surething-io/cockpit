/**
 * /api/services/scripts — P6 migration
 *
 * Reads the project cwd/package.json and returns its scripts field (returns empty object when absent or empty).
 */
import { readFile } from "fs/promises"
import { existsSync } from "fs"
import { join } from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { ValidationError, FSError } from "@cockpit/effect-core"

interface PackageJson {
  scripts?: Record<string, string>
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }

    const packageJsonPath = join(cwd, "package.json")
    if (!existsSync(packageJsonPath)) {
      return ok({ scripts: {} })
    }

    const content = yield* Effect.tryPromise({
      try: () => readFile(packageJsonPath, "utf-8"),
      catch: (cause) =>
        new FSError({ path: packageJsonPath, op: "read", cause }),
    })

    const pkg = yield* Effect.try({
      try: () => JSON.parse(content) as PackageJson,
      catch: (cause) =>
        new ValidationError({
          field: "package.json",
          reason: `invalid JSON: ${String(cause)}`,
        }),
    })

    return ok({ scripts: pkg.scripts ?? {} })
  })
)
