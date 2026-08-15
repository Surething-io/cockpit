/**
 * /api/git/blob — raw bytes of a file AT A GIT REVISION.
 *
 * `git show <rev>:<path>`, streamed out with the right MIME instead of being
 * decoded into a JS string. This is what makes an <img> of a *historical*
 * image possible: /api/files/read can only ever serve the working-tree copy,
 * which for a commit-detail or branch-compare view is the wrong (or missing)
 * revision.
 *
 * Only image extensions are served. This route hands out repository content by
 * path, so the narrow allow-list is deliberate: it is an image endpoint, not a
 * general "cat any blob" endpoint (which is what /api/files/text is for, on the
 * working tree, with its own path guard).
 *
 * `rev` is matched against a conservative character class and the git call goes
 * through execFile with an argv array — no shell, so a path with spaces/quotes
 * is passed through verbatim rather than re-parsed.
 */
import { execFile } from "child_process"
import path from "path"
import { Effect } from "effect"
import { handler } from "@cockpit/effect-runtime/server"
import { ValidationError, NotFoundError } from "@cockpit/effect-core"
import {
  getMimeType,
  isImagePath,
  MAX_IMAGE_SIZE,
} from "@cockpit/feature-explorer/server/files/shared"

/** sha / branch / tag / `HEAD^1` / `main~3` / `@{u}` — no shell metacharacters. */
const REV_PATTERN = /^[0-9A-Za-z._/^~@{}-]+$/

/** Full 40-hex sha (or abbreviated ≥7) → the blob can never change. */
const IMMUTABLE_REV = /^[0-9a-f]{7,40}$/

const gitShowRaw = (
  cwd: string,
  rev: string,
  file: string
): Effect.Effect<Buffer, NotFoundError> =>
  Effect.tryPromise({
    try: () =>
      new Promise<Buffer>((resolve, reject) => {
        execFile(
          "git",
          ["show", `${rev}:${file}`],
          { cwd, maxBuffer: MAX_IMAGE_SIZE, encoding: "buffer" },
          (err, stdout) => (err ? reject(err) : resolve(stdout as Buffer))
        )
      }),
    // A miss here is ordinary: the path simply doesn't exist at that revision
    // (added / deleted files), which the caller renders as an empty side.
    catch: () =>
      new NotFoundError({ resource: "git-blob", id: `${rev}:${file}` }),
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const rev = sp.get("rev")
    const file = sp.get("file")

    if (!rev || !REV_PATTERN.test(rev)) {
      return yield* Effect.fail(
        new ValidationError({
          field: "rev",
          reason: rev ? "invalid revision" : "missing",
        })
      )
    }
    if (!file) {
      return yield* Effect.fail(
        new ValidationError({ field: "file", reason: "missing" })
      )
    }
    if (!isImagePath(file)) {
      return yield* Effect.fail(
        new ValidationError({ field: "file", reason: "not an image" })
      )
    }

    const bytes = yield* gitShowRaw(cwd, rev, file)

    return new Response(new Uint8Array(bytes), {
      status: 200,
      headers: {
        "Content-Type": getMimeType(path.extname(file)),
        "Content-Length": String(bytes.length),
        // A blob at a sha is immutable; a branch name is not.
        "Cache-Control": IMMUTABLE_REV.test(rev)
          ? "private, max-age=31536000, immutable"
          : "no-cache",
        // SVG is served as image/svg+xml and only ever loaded through <img>
        // (which does not run scripts); nosniff + a null CSP keep it that way
        // even if something later navigates straight to this URL.
        "X-Content-Type-Options": "nosniff",
        "Content-Security-Policy": "default-src 'none'; style-src 'unsafe-inline'",
      },
    })
  }).pipe(Effect.withSpan("api.git.blob"))
)
