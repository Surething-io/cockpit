/**
 * /api/html-apps — HTML-apps registry (GET list + POST add).
 *
 * Global registry (~/.cockpit/html.json) of absolute HTML file paths, launched
 * as console browser bubbles. Mirrors /api/skills; enrichment reads each file's
 * <title>/<meta> head via parseHtmlMeta instead of SKILL.md frontmatter.
 */
import { Effect } from "effect"
import {
  HTML_APPS_FILE,
  readJsonFile,
  writeJsonFile,
  withFileLock,
  isAbsolutePath,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import { parseHtmlMeta } from "../../lib/parseHtmlMeta"
import { listBuiltinApps } from "./builtins"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface HtmlAppRecord {
  id: string
  path: string
  addedAt: string
}
interface HtmlAppsFile {
  apps: HtmlAppRecord[]
}
const DEFAULT: HtmlAppsFile = { apps: [] }

function makeId(): string {
  return `html-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const data = yield* Effect.tryPromise({
      // Read under the same lock as POST writes, so a concurrent write can't be
      // read mid-truncate (which would parse-fail → empty list flash).
      try: () => withFileLock(HTML_APPS_FILE, () => readJsonFile<HtmlAppsFile>(HTML_APPS_FILE, DEFAULT)),
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => DEFAULT))

    // Built-in cards are merged in at read time, never persisted (see builtins.ts).
    const builtins = yield* Effect.promise(() => listBuiltinApps())
    const builtinPaths = new Set(builtins.map((b) => b.path))

    const enriched = yield* Effect.promise(() =>
      Promise.all(
        (data.apps || [])
          // A built-in may already sit in html.json from the bookmark button in
          // an earlier version; drop the duplicate and let the built-in win.
          .filter((a) => !builtinPaths.has(a.path))
          .map(async (a) => {
            const meta = await parseHtmlMeta(a.path)
            return {
              id: a.id,
              path: a.path,
              addedAt: a.addedAt,
              name: meta.name,
              title: meta.title,
              description: meta.description,
              icon: meta.icon,
              valid: meta.valid,
            }
          })
      )
    )
    return ok([...builtins, ...enriched])
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as { path?: unknown }
    if (typeof body.path !== "string" || !body.path.trim()) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }
    const trimmed = body.path.trim()
    if (!isAbsolutePath(trimmed)) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "must be absolute" })
      )
    }
    if (!/\.html?$/i.test(trimmed)) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "must be an .html file" })
      )
    }

    const meta = yield* Effect.tryPromise({
      try: () => parseHtmlMeta(trimmed),
      catch: (cause) => new FSError({ path: trimmed, op: "read", cause }),
    })
    if (!meta.valid) {
      return yield* Effect.fail(
        new ValidationError({
          field: "path",
          reason: "File does not exist or cannot be read",
        })
      )
    }

    // Adding a built-in's path would write an entry that GET then filters out,
    // so the "added" toast would be followed by no new card. Report it as
    // already present — which it is, as a built-in card.
    const builtin = (yield* Effect.promise(() => listBuiltinApps())).find(
      (b) => b.path === trimmed
    )
    if (builtin) return ok({ ...builtin, alreadyExists: true })

    const { record, alreadyExists } = yield* Effect.tryPromise({
      try: () =>
        withFileLock(HTML_APPS_FILE, async () => {
          const data = await readJsonFile<HtmlAppsFile>(HTML_APPS_FILE, DEFAULT)
          const existing = data.apps.find((a) => a.path === trimmed)
          if (existing) return { record: existing, alreadyExists: true }
          const next: HtmlAppRecord = {
            id: makeId(),
            path: trimmed,
            addedAt: new Date().toISOString(),
          }
          await writeJsonFile(HTML_APPS_FILE, { apps: [...data.apps, next] })
          return { record: next, alreadyExists: false }
        }),
      catch: (cause) => new FSError({ path: HTML_APPS_FILE, op: "write", cause }),
    })

    return ok({
      id: record.id,
      path: record.path,
      addedAt: record.addedAt,
      name: meta.name,
      title: meta.title,
      description: meta.description,
      icon: meta.icon,
      valid: true,
      alreadyExists,
    })
  })
)
