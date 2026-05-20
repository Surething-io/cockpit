/**
 * /api/extension/version — P6 migration
 *
 * Returns the chrome extension's manifest version / name / path.
 */
import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { NotFoundError } from "@cockpit/effect-core"

interface Manifest {
  readonly version: string
  readonly name: string
}

export const GET = handler(() =>
  Effect.gen(function* () {
    // npm install: no src/ directory; extension lives at ~/.cockpit/chrome-extension/
    // Source link: src/ directory exists; extension lives at {cwd}/chrome-extension/
    const isNpmInstall = !existsSync(join(process.cwd(), "src"))
    const extensionDir = isNpmInstall
      ? join(homedir(), ".cockpit", "chrome-extension")
      : join(process.cwd(), "chrome-extension")

    const manifestPath = join(extensionDir, "manifest.json")

    const manifest = yield* Effect.try({
      try: () => JSON.parse(readFileSync(manifestPath, "utf-8")) as Manifest,
      catch: () =>
        new NotFoundError({ resource: "manifest", id: manifestPath }),
    })

    return ok({
      version: manifest.version,
      name: manifest.name,
      path: extensionDir,
    })
  })
)
