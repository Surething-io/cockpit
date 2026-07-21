/**
 * /apps/[...path] — the single runtime for HTML apps and local file serving.
 *
 * Two address spaces, one injection policy:
 *
 *   /apps/builtin/<name>/...      apps shipped in the package's `apps/` dir
 *   /apps/local/<abs path>        any file on this machine
 *
 * Both are served static-site style: a document plus whatever relative
 * sub-resources it references (./app.jsx, ./style.css, images) resolve back
 * under the same prefix. Known limitation (by design, unchanged): root-relative
 * references (/assets/x.css) escape the prefix and 404 against the app itself —
 * except /html-lib, which the server hosts for exactly this reason.
 *
 * NAMING: this used to be /api/preview. It is not an API (it serves documents,
 * not JSON) and "preview" undersold what it does — with the bash SDK injected
 * this is an execution environment with a shell bridge, not a passive viewer.
 *
 * SDK INJECTION has no marker at all: every .html this route serves gets
 * window.cockpit. There is deliberately nothing to opt into and nothing to
 * forget.
 *
 * Both earlier designs failed the same way — they made injection depend on
 * something that could silently go missing:
 *  - `?bash=1` on the URL did not survive navigation. A form GET with an empty
 *    action rewrites the whole query string, so the reloaded page lost
 *    window.cockpit and every button threw.
 *  - `<meta name="cockpit-name">` in the document survived navigation, but that
 *    tag also registers the panel card / `/name` command, and the registry
 *    happily falls back to the filename when it is absent. So a document could
 *    register as an app and still get no SDK — the two readers disagreed.
 *
 * Making it unconditional costs nothing real: injection was never a security
 * boundary. Any page served here is same-origin and can hand-roll its own
 * WebSocket to /ws/bash with or without our help; the hard enforcement is, and
 * always was, the same-origin check on that upgrade (see wsServer.ts). A page
 * that does not use the SDK is simply unaffected by its presence.
 *
 * `cockpit-name` is therefore purely a registry concern again (parseHtmlMeta),
 * with no bearing on what runs.
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
import {
  injectBashSdk,
  resolveBashCwd,
  fromLocalAppUrl,
  isAbsolutePath,
} from "@cockpit/shared-utils"
import {
  statWithSymlink,
  getMimeType,
} from "@cockpit/feature-explorer/server/files/shared"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const PREFIX = "/apps/"
const BUILTIN = "builtin/"
const LOCAL = "local/"

/** Package root — server.mjs sets COCKPIT_ROOT; cwd is the fallback in dev. */
const APPS_DIR = path.join(process.env.COCKPIT_ROOT || process.cwd(), "apps")

/** Text/asset types the shared image/pdf MIME table doesn't cover */
const EXTRA_MIME: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".htm": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".jsx": "text/javascript; charset=utf-8",
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

const mimeFor = (ext: string) => EXTRA_MIME[ext] ?? getMimeType(ext)

const isHtml = (ext: string) => ext === ".html" || ext === ".htm"

/**
 * Above this size an .html is streamed raw instead of being read in to have the
 * SDK injected. Real apps are documents; anything past this is a generated
 * report being viewed, which wants bytes on screen, not a shell bridge.
 */
const MAX_INJECTABLE_HTML_BYTES = 8 * 1024 * 1024

/**
 * The single SDK-injection decision, shared by both address spaces: being an
 * .html document is the whole rule. See the `SDK INJECTION` note at the top.
 */
const wantsSdk = (ext: string) => isHtml(ext)

/** Purely local app — no caching (see CLAUDE.md), always serve fresh bytes. */
const NO_STORE = { "Cache-Control": "no-store" } as const

const htmlResponse = (body: string, contentType: string) =>
  new Response(body, {
    status: 200,
    headers: {
      "Content-Type": contentType,
      "Content-Length": String(Buffer.byteLength(body)),
      ...NO_STORE,
    },
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const url = new URL(req.url)
    if (!url.pathname.startsWith(PREFIX)) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }
    const rest = url.pathname.slice(PREFIX.length)

    // ---- /apps/builtin/<name>/... : first-party apps from the package ----
    if (rest.startsWith(BUILTIN)) {
      // decodeURIComponent throws on a malformed escape (a bare `%`); without
      // this it escapes as a defect and surfaces as a 500 instead of a 400.
      const relPath = yield* Effect.try({
        try: () => decodeURIComponent(rest.slice(BUILTIN.length)),
        catch: () =>
          new ValidationError({ field: "path", reason: "malformed encoding" }),
      })
      // Resolve inside APPS_DIR and verify containment — `..` segments must not
      // escape into the rest of the package.
      const resolved = path.normalize(path.join(APPS_DIR, relPath))
      const target = path.extname(resolved)
        ? resolved
        : path.join(resolved, "index.html")
      if (target !== APPS_DIR && !target.startsWith(APPS_DIR + path.sep)) {
        return yield* Effect.fail(
          new PermissionError({ action: "read", resource: url.pathname })
        )
      }

      const body = yield* Effect.tryPromise({
        try: () => readFile(target),
        catch: () => new NotFoundError({ resource: "app", id: url.pathname }),
      })
      const ext = path.extname(target).toLowerCase()
      const contentType = mimeFor(ext)

      // Decode only for html — a png/woff2/wasm must not pay a full UTF-8
      // decode just to be told it is not a document.
      if (wantsSdk(ext)) {
        // `?file=<abs>` points the SDK cwd at the file the app was opened for,
        // so the app can address its target with a bare basename. It must be
        // absolute: a relative value would silently resolve the app's shell
        // commands against the server process cwd instead of failing loudly.
        const forFile = url.searchParams.get("file")
        if (forFile && !isAbsolutePath(forFile)) {
          return yield* Effect.fail(
            new ValidationError({
              field: "file",
              reason: "must be an absolute path",
            })
          )
        }
        const cwd = forFile ? resolveBashCwd(forFile) : path.dirname(target)
        return htmlResponse(
          injectBashSdk(body.toString("utf-8"), { cwd }),
          contentType
        )
      }
      return new Response(new Uint8Array(body), {
        status: 200,
        headers: {
          "Content-Type": contentType,
          "Content-Length": String(body.byteLength),
          ...NO_STORE,
        },
      })
    }

    // ---- /apps/local/<abs path> : any file on this machine ----
    if (!rest.startsWith(LOCAL)) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "unknown app namespace" })
      )
    }

    // Decode + normalize separators + strip the drive-path leading slash +
    // guard against traversal (posix `/Users/..` and `C:/Users/..` both).
    const raw = fromLocalAppUrl(url.pathname)
    if (raw === null) {
      return yield* Effect.fail(
        new PermissionError({ action: "read", resource: url.pathname })
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
    const contentType = mimeFor(ext)

    // An .html document is read in full because injection rewrites it;
    // everything else (images, pdfs, video) still streams. `/apps/local` serves
    // arbitrary paths, not just small app files, so cap the read rather than
    // assume documents are small — a multi-hundred-MB generated report (nyc,
    // pytest-html, heap dump) would otherwise be buffered whole, and Cockpit is
    // a single process. Past the cap, serve it as a plain stream with no SDK:
    // degrading to "no bridge" beats an OOM that takes every panel down.
    if (isHtml(ext) && info.size <= MAX_INJECTABLE_HTML_BYTES) {
      const html = yield* Effect.tryPromise({
        try: () => readFile(fullPath, "utf-8"),
        catch: (cause) =>
          new ValidationError({ field: "path", reason: String(cause) }),
      })
      // wsUrl is left empty: the SDK derives ws://host/ws/bash from
      // window.location (this iframe has a real origin, unlike srcDoc).
      // fullPath is already absolute + normalized, so resolveBashCwd degenerates
      // to a plain dirname — shared with HtmlPreview to avoid drift.
      return htmlResponse(
        injectBashSdk(html, { cwd: resolveBashCwd(fullPath) }),
        contentType
      )
    }

    const stream = createReadStream(fullPath)
    return new Response(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": contentType,
        "Content-Length": String(info.size),
        ...NO_STORE,
      },
    })
  })
)
