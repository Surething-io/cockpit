/**
 * /api/files/read — P8+ migration
 *
 * Streams image bytes (supports Range 206 / conditional GET 304 / multiple HTTP statuses).
 * Non-image paths return 409 to hint the caller toward /text or /stat.
 */
import { createReadStream } from "fs"
import { Readable } from "stream"
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
  buildCacheHeaders,
  ifNoneMatch,
  getMimeType,
  MAX_IMAGE_SIZE,
} from "@cockpit/feature-explorer/server/files/shared"

const jsonResp = (body: unknown, status: number): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
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
        new PermissionError({ action: "read", resource: filePath })
      )
    }

    const info = yield* Effect.tryPromise({
      try: () => statWithSymlink(fullPath),
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException)?.code
        return code === "ENOENT"
          ? new NotFoundError({ resource: "file", id: filePath })
          : new ValidationError({ field: "path", reason: String(cause) })
      },
    })

    if (info.isDirectory) {
      return jsonResp({ error: "Path is a directory" }, 409)
    }

    const ext = path.extname(filePath).toLowerCase()
    const category = classify(ext, info.size)

    if (category === "too-large") {
      return jsonResp(
        {
          error: `File too large (over ${Math.floor(MAX_IMAGE_SIZE / 1024 / 1024)}MB)`,
          size: info.size,
        },
        413
      )
    }
    if (category !== "image" && category !== "pdf") {
      return jsonResp(
        {
          error: `This endpoint streams images/PDFs only (category: ${category}). Use /api/files/text for text.`,
          category,
        },
        409
      )
    }

    const etag = computeETag(info.size, info.mtimeMs)

    if (ifNoneMatch(req.headers.get("if-none-match"), etag)) {
      return new Response(null, {
        status: 304,
        headers: buildCacheHeaders(etag, info.mtimeMs),
      })
    }

    const baseHeaders = {
      ...buildCacheHeaders(etag, info.mtimeMs),
      "Content-Type": getMimeType(ext),
      "Accept-Ranges": "bytes",
    }

    const range = req.headers.get("range")
    if (range) {
      const match = /^bytes=(\d*)-(\d*)$/.exec(range)
      if (match) {
        const start = match[1] ? parseInt(match[1], 10) : 0
        const end = match[2] ? parseInt(match[2], 10) : info.size - 1
        if (
          Number.isFinite(start) &&
          Number.isFinite(end) &&
          start >= 0 &&
          end < info.size &&
          start <= end
        ) {
          const stream = createReadStream(fullPath, { start, end })
          return new Response(
            Readable.toWeb(stream) as ReadableStream,
            {
              status: 206,
              headers: {
                ...baseHeaders,
                "Content-Length": String(end - start + 1),
                "Content-Range": `bytes ${start}-${end}/${info.size}`,
              },
            }
          )
        }
        return new Response(null, {
          status: 416,
          headers: { "Content-Range": `bytes */${info.size}` },
        })
      }
    }

    const stream = createReadStream(fullPath)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        ...baseHeaders,
        "Content-Length": String(info.size),
      },
    })
  })
)
