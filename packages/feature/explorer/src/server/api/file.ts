/**
 * /api/file — P8+ migration
 *
 * Absolute-path file reader (used by chat tool-call previews);
 * multiple HTTP statuses: 200/206/304/400/403/404/409/413/416/500.
 */
import { readFile, stat } from "fs/promises"
import { createReadStream } from "fs"
import { Readable } from "stream"
import path from "path"
import { Effect } from "effect"
import { handler } from "@cockpit/effect-runtime/server"
import {
  NotFoundError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"
import {
  classify,
  computeETag,
  buildCacheHeaders,
  ifNoneMatch,
  isBinaryContent,
  getMimeType,
  MAX_TEXT_SIZE,
  MAX_IMAGE_SIZE,
} from "@cockpit/feature-explorer/server/files/shared"

const jsonResp = (body: unknown, status: number, extra?: HeadersInit): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(extra as Record<string, string>),
    },
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const filePath = sp.get("path")
    const raw = sp.get("raw") === "true"

    if (!filePath) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }
    if (filePath.includes("\0")) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "null byte" })
      )
    }
    if (!path.isAbsolute(filePath)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "path",
          reason:
            "This endpoint requires absolute path; use /api/files/* for cwd-relative",
        })
      )
    }

    const absolutePath = path.resolve(filePath)

    const stats = yield* Effect.tryPromise({
      try: () => stat(absolutePath),
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException)?.code
        if (code === "ENOENT") {
          return new NotFoundError({ resource: "file", id: filePath })
        }
        if (code === "EACCES") {
          return new PermissionError({
            action: "read",
            resource: filePath,
          })
        }
        return new ValidationError({
          field: "path",
          reason: String(cause),
        })
      },
    })

    if (stats.isDirectory()) {
      return jsonResp({ error: "Path is a directory" }, 409)
    }
    if (!stats.isFile()) {
      return jsonResp({ error: "Not a regular file" }, 400)
    }

    const ext = path.extname(absolutePath).toLowerCase()
    const category = classify(ext, stats.size)
    const etag = computeETag(stats.size, stats.mtimeMs)

    // ---- Image stream ----
    if (raw) {
      if (category === "too-large") {
        return jsonResp(
          {
            error: `Image too large (over ${Math.floor(MAX_IMAGE_SIZE / 1024 / 1024)}MB)`,
            size: stats.size,
          },
          413
        )
      }
      if (category !== "image") {
        return jsonResp(
          {
            error: `raw=true only supports image files (category: ${category})`,
            category,
          },
          409
        )
      }

      if (ifNoneMatch(req.headers.get("if-none-match"), etag)) {
        return new Response(null, {
          status: 304,
          headers: buildCacheHeaders(etag, stats.mtimeMs),
        })
      }

      const baseHeaders = {
        ...buildCacheHeaders(etag, stats.mtimeMs),
        "Content-Type": getMimeType(ext),
        "Accept-Ranges": "bytes",
      }

      const range = req.headers.get("range")
      if (range) {
        const m = /^bytes=(\d*)-(\d*)$/.exec(range)
        if (m) {
          const start = m[1] ? parseInt(m[1], 10) : 0
          const end = m[2] ? parseInt(m[2], 10) : stats.size - 1
          if (
            Number.isFinite(start) &&
            Number.isFinite(end) &&
            start >= 0 &&
            end < stats.size &&
            start <= end
          ) {
            const stream = createReadStream(absolutePath, { start, end })
            return new Response(
              Readable.toWeb(stream) as ReadableStream,
              {
                status: 206,
                headers: {
                  ...baseHeaders,
                  "Content-Length": String(end - start + 1),
                  "Content-Range": `bytes ${start}-${end}/${stats.size}`,
                },
              }
            )
          }
          return new Response(null, {
            status: 416,
            headers: { "Content-Range": `bytes */${stats.size}` },
          })
        }
      }

      const stream = createReadStream(absolutePath)
      return new Response(Readable.toWeb(stream) as ReadableStream, {
        status: 200,
        headers: {
          ...baseHeaders,
          "Content-Length": String(stats.size),
        },
      })
    }

    // ---- Text JSON (default) ----
    if (category === "image" || category === "binary") {
      return jsonResp(
        {
          error: `Not a text file (category: ${category}). Use raw=true for images.`,
          category,
        },
        409
      )
    }
    if (category === "too-large" || stats.size > MAX_TEXT_SIZE) {
      return jsonResp(
        {
          error: `File too large (over ${Math.floor(MAX_TEXT_SIZE / 1024 / 1024)}MB)`,
          size: stats.size,
        },
        413
      )
    }

    const content = yield* Effect.tryPromise({
      try: () => readFile(absolutePath, "utf-8"),
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
        path: absolutePath,
        size: stats.size,
        mtimeMs: stats.mtimeMs,
        etag,
      },
      200,
      { "Cache-Control": "no-cache" }
    )
  })
)
