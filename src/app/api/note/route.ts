/**
 * /api/note — P6 migration
 *
 * Note CRUD (two scopes: project-level / global).
 */
import { readFile, writeFile } from "fs/promises"
import { Effect } from "effect"
import {
  COCKPIT_DIR,
  NOTE_FILE,
  ensureDir,
  getProjectNotePath,
  getCockpitProjectDir,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface NotePaths {
  readonly filePath: string
  readonly dir: string
}

const resolvePaths = (url: string): NotePaths => {
  const { searchParams } = new URL(url)
  const cwd = searchParams.get("cwd")
  if (cwd) {
    return {
      filePath: getProjectNotePath(cwd),
      dir: getCockpitProjectDir(cwd),
    }
  }
  return { filePath: NOTE_FILE, dir: COCKPIT_DIR }
}

const ensureDirEff = (dir: string): Effect.Effect<void, FSError> =>
  Effect.tryPromise({
    try: () => ensureDir(dir),
    catch: (cause) => new FSError({ path: dir, op: "mkdir", cause }),
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const { filePath, dir } = resolvePaths(req.url)
    yield* ensureDirEff(dir)
    // On read failure (file missing) fall back to empty string, matching v1
    const content = yield* Effect.tryPromise({
      try: () => readFile(filePath, "utf-8"),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ""))
    return ok({ content })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const { filePath, dir } = resolvePaths(req.url)
    const body = (yield* parseJsonRaw(req)) as { content?: string }
    yield* ensureDirEff(dir)
    yield* Effect.tryPromise({
      try: () => writeFile(filePath, body.content ?? "", "utf-8"),
      catch: (cause) => new FSError({ path: filePath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
