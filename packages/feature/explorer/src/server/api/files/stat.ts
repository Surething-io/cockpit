/**
 * /api/files/stat
 *
 * Lightweight file metadata (no byte read), including a `category`
 * classification (image / text / binary / too-large) and an etag.
 */
import path from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import {
  FSError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"
import {
  resolveSafePath,
  statWithSymlink,
  classify,
  computeETag,
  getMimeType,
  type FileCategory,
} from "@cockpit/feature-explorer/server/files/shared"

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const filePath = sp.get("path")

    if (!filePath) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }

    const fullPath = resolveSafePath(cwd, filePath)
    if (!fullPath) {
      return yield* Effect.fail(
        new PermissionError({ action: "stat", resource: filePath })
      )
    }

    // File missing -> exists: false (do not error out)
    const info = yield* Effect.tryPromise({
      try: () => statWithSymlink(fullPath),
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException)?.code
        if (code === "ENOENT") return null // signal "not found"
        return new FSError({ path: fullPath, op: "stat", cause })
      },
    }).pipe(
      Effect.catchAll((e) =>
        e === null ? Effect.succeed(null) : Effect.fail(e)
      )
    )

    if (info === null) {
      return new Response(JSON.stringify({ exists: false }), {
        headers: {
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
        },
      })
    }

    const ext = path.extname(filePath).toLowerCase()
    let kind: "file" | "dir" | "symlink" = "file"
    if (info.isDirectory) kind = "dir"
    else if (info.isSymlink) kind = "symlink"

    let category: FileCategory | null = null
    let mimeType: string | undefined
    let etag: string | undefined
    if (!info.isDirectory) {
      category = classify(ext, info.size)
      mimeType = category === "image" ? getMimeType(ext) : undefined
      etag = computeETag(info.size, info.mtimeMs)
    }

    return new Response(
      JSON.stringify({
        exists: true,
        kind,
        size: info.size,
        mtimeMs: info.mtimeMs,
        isSymlink: info.isSymlink,
        symlinkTarget: info.symlinkTarget,
        category,
        mimeType,
        etag,
      }),
      {
        headers: {
          "Cache-Control": "no-cache",
          "Content-Type": "application/json",
        },
      }
    )
  })
)

// Reference `ok` to avoid an unused-import lint warning; this route uses a
// raw Response so it can attach custom headers.
void ok
