/**
 * /api/html-apps/files — an HTML app's files, for the apps board's file tree.
 *
 *   GET ?id=<appId>              → { dir, files: [{ path, size }], truncated }
 *   GET ?id=<appId>&path=<rel>   → { path, kind, content?, size }
 *
 * Same shapes as /api/skills/files and /api/bots/files (one DirectoryPane
 * renders all three). An app is registered as a single .html file, so "its
 * directory" is a judgement:
 *   - the folder holds no other .html → it is the app's own folder (an app with
 *     its app.jsx / data / assets next to it): list all of it;
 *   - it holds other .html too → a shared folder (e.g. several one-file apps
 *     dropped in one place, next to thousands of unrelated files): list and
 *     serve only the app's file.
 * The file comes from the registry (built-ins included), never from the client;
 * reads are confined to the folder (@cockpit/shared-utils/dirFiles).
 */
import { readdir, stat } from "fs/promises"
import nodePath from "path"
import { Effect } from "effect"
import { HTML_APPS_FILE, readJsonFile } from "@cockpit/shared-utils"
import { listDirFiles, readFileWithin } from "@cockpit/shared-utils/dirFiles"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { NotFoundError, ValidationError } from "@cockpit/effect-core"
import { listBuiltinApps } from "./builtins"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const appPathById = (id: string) =>
  Effect.gen(function* () {
    const builtin = (yield* listBuiltinApps()).find((a) => a.id === id)
    if (builtin) return builtin.path
    const data = yield* Effect.tryPromise(() =>
      readJsonFile<{ apps: { id: string; path: string }[] }>(HTML_APPS_FILE, { apps: [] }),
    ).pipe(Effect.orElseSucceed(() => ({ apps: [] as { id: string; path: string }[] })))
    return data.apps.find((a) => a.id === id)?.path
  })

/** True when `dir` holds an .html file other than `file`. */
const isSharedFolder = (dir: string, file: string) =>
  Effect.tryPromise(() => readdir(dir)).pipe(
    Effect.map((names) => names.some((n) => n !== file && /\.html?$/i.test(n))),
    Effect.orElseSucceed(() => true),
  )

export const GET = handler((req) =>
  Effect.gen(function* () {
    const params = new URL(req.url).searchParams
    const id = params.get("id")
    if (!id) return yield* Effect.fail(new ValidationError({ field: "id", reason: "missing" }))
    const appPath = yield* appPathById(id)
    if (!appPath) return yield* Effect.fail(new NotFoundError({ resource: "html-app", id }))
    const dir = nodePath.dirname(appPath)
    const file = nodePath.basename(appPath)
    const shared = yield* isSharedFolder(dir, file)

    const rel = params.get("path")
    if (rel === null) {
      if (shared) {
        const size = yield* Effect.tryPromise(() => stat(appPath)).pipe(
          Effect.map((s) => s.size),
          Effect.orElseSucceed(() => 0),
        )
        return ok({ dir, files: [{ path: file, size }], truncated: false })
      }
      const listing = yield* Effect.tryPromise(() => listDirFiles(dir)).pipe(
        Effect.orElseSucceed(() => ({ files: [], truncated: false })),
      )
      return ok({ dir, ...listing })
    }

    // In a shared folder only the app's own file is served.
    if (shared && rel !== file) {
      return yield* Effect.fail(new ValidationError({ field: "path", reason: "outside app" }))
    }
    const read = yield* Effect.tryPromise(() => readFileWithin(dir, rel)).pipe(
      Effect.orElseSucceed(() => ({ kind: "missing" as const })),
    )
    if (read.kind === "outside") return yield* Effect.fail(new ValidationError({ field: "path", reason: "outside app directory" }))
    if (read.kind === "missing") return yield* Effect.fail(new NotFoundError({ resource: "file", id: rel }))
    return ok({ path: rel, ...read })
  }),
)
