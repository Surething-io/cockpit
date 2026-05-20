/**
 * /api/projectGraph/file-functions — P8+ migration
 */
import { readFile, stat } from "node:fs/promises"
import { Effect } from "effect"
import {
  fileFunctionsFromIndex,
  getCodeIndex,
  invalidateIndex,
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

    const result = yield* Effect.tryPromise({
      try: async () => {
        const index = await getCodeIndex(cwd, { forceRefresh })
        await refreshFocalFile(cwd, filePath, index)
        const payload = fileFunctionsFromIndex(index, filePath)
        if (payload) return { kind: "indexed" as const, payload }

        const fullPath = resolveSafePath(cwd, filePath)
        if (!fullPath) return { kind: "not-found" as const }
        const stats = await stat(fullPath).catch(() => null)
        if (!stats?.isFile()) return { kind: "not-found" as const }

        if (/\.mdx?$/i.test(filePath)) {
          const text = await readFile(fullPath, "utf-8").catch(() => null)
          if (text) {
            return {
              kind: "markdown" as const,
              payload: {
                filePath,
                language: "markdown",
                fileCount: index.files.size,
                mtimeMs: stats.mtimeMs,
                functions: chunkMarkdown(filePath, text),
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
            filePath,
            language: "text",
            fileCount: index.files.size,
            mtimeMs: stats.mtimeMs,
            functions: [],
            intraCalls: [],
            externalCalls: [],
            methodCalls: [],
            upstreamCalls: [],
            downstreamCalls: [],
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
        new NotFoundError({ resource: "file", id: filePath })
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
