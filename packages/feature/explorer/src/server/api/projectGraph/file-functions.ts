/**
 * /api/projectGraph/file-functions — P8+ migration
 */
import { readFile, stat } from "node:fs/promises"
import path from "node:path"
import { Effect } from "effect"
import {
  codeIndexBuildFailed,
  ensureCodeIndex,
  fileFunctionsFromIndex,
  fileFunctionsLocal,
  invalidateIndex,
  peekCodeIndex,
  refreshFocalFile,
} from "@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex"
import type { FunctionNode } from "@cockpit/feature-explorer/server/codeMap/projectGraph/types"
import {
  resolveSafePath,
  validateCwd,
} from "@cockpit/feature-explorer/server/files/shared"
import { handler } from "@cockpit/effect-runtime/server"
import {
  AppError,
  NotFoundError,
  ValidationError,
} from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

const jsonResp = (
  body: unknown,
  status: number,
  noCache = true
): Response =>
  new Response(JSON.stringify(body), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(noCache ? { "Cache-Control": "no-cache" } : {}),
    },
  })

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwdParam = sp.get("cwd")
    const filePath = sp.get("path")
    const forceRefresh = sp.get("refresh") === "1"

    const cwdCheck = yield* Effect.promise(() => validateCwd(cwdParam))
    if (!cwdCheck.ok) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: cwdCheck.reason })
      )
    }
    const cwd = cwdCheck.abs
    if (!filePath) {
      return yield* Effect.fail(
        new ValidationError({ field: "path", reason: "missing" })
      )
    }
    // Normalize once at the entry — `index.files` is keyed by string and
    // would create separate entries for "foo.ts" vs "./foo.ts" otherwise.
    // After normalization, addFocalFile / refreshFocalFile / fileFunctionsFromIndex
    // / resolveSafePath all see the same canonical form (matches what
    // `git ls-files` produces in buildCodeIndex).
    const normalizedPath = path.posix.normalize(filePath).replace(/^\.\//, "")
    if (
      normalizedPath.startsWith("../") ||
      normalizedPath.startsWith("/") ||
      normalizedPath === "" ||
      normalizedPath === "."
    ) {
      return yield* Effect.fail(
        new ValidationError({
          field: "path",
          reason: "must be a project-relative path",
        })
      )
    }

    const result = yield* Effect.tryPromise({
      try: async () => {
        // Never wait for the project index: a cold build is O(project)
        // (~45s at 12.8K files), and this route is asked about ONE file.
        // Without an index, answer the file-local layer and let the build
        // run in the background — see `crossFilePending` in types.ts.
        if (forceRefresh) ensureCodeIndex(cwd, { forceRefresh: true })
        const index = peekCodeIndex(cwd)
        // A failed background build will not deliver cross-file data on its
        // own; don't promise it (the client would wait for nothing).
        const crossFilePending = !index && !codeIndexBuildFailed(cwd)
        if (index) {
          await refreshFocalFile(cwd, normalizedPath, index)
          const payload = fileFunctionsFromIndex(index, normalizedPath)
          if (payload) return { kind: "indexed" as const, payload }
        } else {
          ensureCodeIndex(cwd)
          const local = await fileFunctionsLocal(cwd, normalizedPath)
          if (local) {
            return {
              kind: "indexed" as const,
              payload: { ...local, fileCount: 0, crossFilePending },
            }
          }
        }
        const fileCount = index?.files.size ?? 0

        const fullPath = resolveSafePath(cwd, normalizedPath)
        if (!fullPath) return { kind: "not-found" as const }
        const stats = await stat(fullPath).catch(() => null)
        if (!stats?.isFile()) return { kind: "not-found" as const }

        if (/\.mdx?$/i.test(normalizedPath)) {
          const text = await readFile(fullPath, "utf-8").catch(() => null)
          if (text) {
            return {
              kind: "markdown" as const,
              payload: {
                filePath: normalizedPath,
                language: "markdown",
                fileCount,
                mtimeMs: stats.mtimeMs,
                functions: chunkMarkdown(normalizedPath, text),
                intraCalls: [],
                externalCalls: [],
                methodCalls: [],
                upstreamCalls: [],
                downstreamCalls: [],
              },
            }
          }
        }
        return {
          kind: "fallback" as const,
          payload: {
            filePath: normalizedPath,
            language: "text",
            fileCount,
            mtimeMs: stats.mtimeMs,
            functions: [],
            intraCalls: [],
            externalCalls: [],
            methodCalls: [],
            upstreamCalls: [],
            downstreamCalls: [],
            // The file is on disk and resolvable, but addFocalFile rejected
            // it (unsupported language / not in project fileset / MAX_FILES).
            // Client uses this flag to render a graceful "not indexed" hint
            // with a rebuild button, instead of the generic "no functions"
            // empty state.
            // Without an index we can't tell "rejected by the index" from
            // "not indexed yet" — leave the verdict to the refetch.
            notIndexed: !crossFilePending,
            crossFilePending,
          },
        }
      },
      catch: (cause) => {
        invalidateIndex(cwd)
        return new AppError({
          message: "Failed to load file functions",
          cause,
        })
      },
    })

    if (result.kind === "not-found") {
      return yield* Effect.fail(
        new NotFoundError({ resource: "file", id: normalizedPath })
      )
    }
    return jsonResp(result.payload, 200)
  })
)

function chunkMarkdown(filePath: string, text: string): FunctionNode[] {
  const lines = text.split("\n")
  const headings: { line: number; name: string }[] = []
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line.startsWith("```")) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const m = /^(#{1,6})\s*(.+?)\s*#*\s*$/.exec(line)
    if (m) {
      headings.push({ line: i + 1, name: m[2].trim() })
    }
  }
  if (headings.length === 0) {
    return [
      {
        filePath,
        qualifiedName: "__file__",
        name: basename(filePath),
        kind: "unknown",
        startLine: 1,
        endLine: Math.max(1, lines.length),
      },
    ]
  }
  const blocks: FunctionNode[] = []
  if (headings[0].line > 1) {
    blocks.push({
      filePath,
      qualifiedName: "__preamble__",
      name: "preamble",
      kind: "unknown",
      startLine: 1,
      endLine: headings[0].line - 1,
    })
  }
  for (let i = 0; i < headings.length; i++) {
    const h = headings[i]
    const next = headings[i + 1]
    const endLine = next ? next.line - 1 : lines.length
    blocks.push({
      filePath,
      qualifiedName: `__heading_${h.line}__`,
      name: h.name,
      kind: "unknown",
      startLine: h.line,
      endLine: Math.max(h.line, endLine),
    })
  }
  return blocks
}

function basename(p: string): string {
  const i = p.lastIndexOf("/")
  return i >= 0 ? p.slice(i + 1) : p
}
