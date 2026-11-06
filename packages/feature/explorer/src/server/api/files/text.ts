/**
 * /api/files/text — P8+ migration
 *
 * Reads utf-8 text with multiple HTTP statuses: 200 / 400 / 403 / 404 / 409 / 413 / 500.
 * 409/413 are built via raw Response (they are not in the errorToStatus standard mapping).
 */
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
  MAX_TEXT_SIZE,
} from "@cockpit/feature-explorer/server/files/shared"

import { readTextPreview } from '../../files/textPreview'

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

    if (!result.isFile) return jsonResp({ error: "Not a regular file" }, 409)

    const ext = path.extname(filePath).toLowerCase()
    const category = classify(ext, result.size)

    if (category === "image") {
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

    const text = yield* readTextPreview(fullPath)
    if (text.kind !== "text") {
      const error = text.kind === "too-large" ? "File too large (over 10MB)"
        : text.kind === "binary" ? "File appears to be binary" : "Not a regular file"
      return jsonResp({ error, category: text.kind, size: text.size }, text.kind === "too-large" ? 413 : 409)
    }

    return jsonResp(
      {
        content: text.content,
        size: text.size,
        mtimeMs: text.mtimeMs,
        etag: computeETag(text.size, text.mtimeMs),
        ...(result.isSymlink
          ? { isSymlink: true, symlinkTarget: result.symlinkTarget }
          : {}),
      },
      200
    )
  })
)
