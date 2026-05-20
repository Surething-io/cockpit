/**
 * /api/files/text — P8+ migration
 *
 * Reads utf-8 text with multiple HTTP statuses: 200 / 400 / 403 / 404 / 409 / 413 / 500.
 * 409/413 are built via raw Response (they are not in the errorToStatus standard mapping).
 */
import { readFile } from "fs/promises"
import path from "path"
import { Effect } from "effect"
import { handler } from "@cockpit/effect-runtime/server"
import {
  PermissionError,
  ValidationError,
  NotFoundError,
} from "@cockpit/effect-core"
import {
  resolveSafePath,
  statWithSymlink,
  classify,
  computeETag,
  isBinaryContent,
  MAX_TEXT_SIZE,
} from "@cockpit/feature-explorer/server/files/shared"

const jsonResp = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Cache-Control": "no-cache",
      "Content-Type": "application/json",
    },
  })

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
        new PermissionError({ action: "read-text", resource: filePath })
      )
    }

    const result = yield* Effect.tryPromise({
      try: () => statWithSymlink(fullPath),
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException)?.code
        return code === "ENOENT"
          ? new NotFoundError({ resource: "file", id: filePath })
          : new ValidationError({ field: "path", reason: String(cause) })
      },
    })

    if (result.isDirectory) {
      return jsonResp({ error: "Path is a directory" }, 409)
    }

    const ext = path.extname(filePath).toLowerCase()
    const category = classify(ext, result.size)

    if (category === "image" || category === "binary") {
      return jsonResp(
        { error: `Not a text file (category: ${category})`, category },
        409
      )
    }
    if (category === "too-large" || result.size > MAX_TEXT_SIZE) {
      return jsonResp(
        {
          error: `File too large (over ${Math.floor(MAX_TEXT_SIZE / 1024 / 1024)}MB)`,
          size: result.size,
        },
        413
      )
    }

    const content = yield* Effect.tryPromise({
      try: () => readFile(fullPath, "utf-8"),
      catch: (cause) =>
        new ValidationError({ field: "path", reason: String(cause) }),
    })

    if (isBinaryContent(content)) {
      return jsonResp(
        { error: "File appears to be binary", category: "binary" },
        409
      )
    }

    return jsonResp(
      {
        content,
        size: result.size,
        mtimeMs: result.mtimeMs,
        etag: computeETag(result.size, result.mtimeMs),
        ...(result.isSymlink
          ? { isSymlink: true, symlinkTarget: result.symlinkTarget }
          : {}),
      },
      200
    )
  })
)
