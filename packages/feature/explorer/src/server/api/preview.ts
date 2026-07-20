/**
 * /api/preview/[...path] — static-server style local file preview
 *
 * Serves an absolute local file path with a Content-Type derived from its
 * extension, so the console browser bubble can render local HTML files in
 * its iframe. Relative asset references inside the page (./style.css,
 * ./app.js, images) resolve back under the same /api/preview prefix, making
 * a report directory behave like a real static site.
 *
 * Known limitation (by design): root-relative references (/assets/x.css)
 * escape the /api/preview prefix and 404 against the app itself.
 */
import { createReadStream } from "fs"
import { readFile } from "fs/promises"
import { Readable } from "stream"
import path from "path"
import { Effect } from "effect"
import { handler } from "@cockpit/effect-runtime/server"
import {
  NotFoundError,
  PermissionError,
  ValidationError,
} from "@cockpit/effect-core"
import { injectBashSdk, resolveBashCwd, fromPreviewUrl } from "@cockpit/shared-utils"
import {
  statWithSymlink,
  getMimeType,
} from "@cockpit/feature-explorer/server/files/shared"

const PREFIX = "/api/preview/"

/** Text/asset types the shared image/pdf MIME table doesn't cover */
const PREVIEW_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml; charset=utf-8",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".otf": "font/otf",
  ".wasm": "application/wasm",
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const reqUrl = new URL(req.url)
    const pathname = reqUrl.pathname
    // Inject the bash SDK ONLY for top-level, user-opened previews (marked
    // `?bash=1` by toPreviewUrl — every caller is a deliberate gesture).
    // Relative sub-resources loaded FROM a previewed page (./app.jsx, nested
    // html, file-viewer fetches) arrive without the query and are served raw.
    // The hard enforcement is the /ws/bash same-origin gate; this gate just
    // avoids shipping a live RCE bridge inside every referenced .html.
    const wantBash = reqUrl.searchParams.get("bash") === "1"
    if (!pathname.startsWith(PREFIX)) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }

    // Decode + normalize separators + strip the drive-path leading slash + guard
    // against traversal (posix `/Users/..` and Windows `C:/Users/..` both handled).
    const raw = fromPreviewUrl(pathname)
    if (raw === null) {
      return yield* Effect.fail(
        new PermissionError({ action: "read", resource: pathname })
      )
    }
    const fullPath = path.normalize(raw)

    const info = yield* Effect.tryPromise({
      try: () => statWithSymlink(fullPath),
      catch: (cause) => {
        const code = (cause as NodeJS.ErrnoException)?.code
        return code === "ENOENT"
          ? new NotFoundError({ resource: "file", id: fullPath })
          : new ValidationError({ field: "path", reason: String(cause) })
      },
    })
    if (info.isDirectory) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "is a directory" })
      )
    }

    const ext = path.extname(fullPath).toLowerCase()
    const contentType = PREVIEW_MIME[ext] ?? getMimeType(ext)

    // HTML files get the window.cockpit bash SDK injected (same capability the
    // srcDoc HtmlPreview grants), so the console browser bubble — which loads
    // local HTML over this real same-origin URL — can call cockpit.bash(...).
    // wsUrl is left empty: the SDK derives ws://host/ws/bash from window.location
    // (this iframe has a real origin, unlike the srcDoc preview). Read fully into
    // a string since injection rewrites the body and Content-Length changes.
    if ((ext === ".html" || ext === ".htm") && wantBash) {
      const html = yield* Effect.tryPromise({
        try: () => readFile(fullPath, "utf-8"),
        catch: (cause) =>
          new ValidationError({ field: "path", reason: String(cause) }),
      })
      // fullPath is already absolute + normalized, so resolveBashCwd degenerates
      // to a plain dirname here — shared with HtmlPreview to avoid drift.
      const injected = injectBashSdk(html, { cwd: resolveBashCwd(fullPath) })
      return new Response(injected, {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(Buffer.byteLength(injected)),
          "Cache-Control": "no-store",
        },
      })
    }

    const stream = createReadStream(fullPath)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(info.size),
        // Purely local app — no caching (see CLAUDE.md), always serve fresh bytes
        "Cache-Control": "no-store",
      },
    })
  })
)
