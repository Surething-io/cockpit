/**
 * /api/files/search — P8+ migration
 *
 * ripgrep content search + throttling (file/match/total line caps).
 */
import { execFile } from "child_process"
import { promisify } from "util"
import { rgPath as RG_PATH } from "@vscode/ripgrep"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError } from "@cockpit/effect-core"

const execFileAsync = promisify(execFile)

export interface SearchMatch {
  lineNumber: number
  content: string
}
export interface SearchResult {
  path: string
  matches: SearchMatch[]
}

const MAX_FILES = 100
const MAX_MATCHES_PER_FILE = 50
const MAX_TOTAL_LINES = 5000

interface SearchOptions {
  caseSensitive: boolean
  wholeWord: boolean
  regex: boolean
  fileType: string
}

async function searchWithRg(
  rgBin: string,
  cwd: string,
  query: string,
  opts: SearchOptions
): Promise<{ stdout: string }> {
  const args: string[] = [
    "--no-heading",
    "--line-number",
    "--color",
    "never",
    "--max-columns",
    "500",
    "--max-count",
    String(MAX_MATCHES_PER_FILE),
    "--max-filesize",
    "1M",
    "--hidden",
    "--follow",
    "--glob",
    "!.git",
  ]
  if (!opts.caseSensitive) args.push("-i")
  if (opts.wholeWord) args.push("-w")
  if (!opts.regex) args.push("-F")
  if (opts.fileType) {
    const types = opts.fileType
      .split(",")
      .map((t) => t.trim())
      .filter(Boolean)
    for (const t of types) {
      args.push("-g", `*.${t}`)
    }
  }
  args.push("--", query, ".")

  try {
    return await execFileAsync(rgBin, args, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 10000,
    })
  } catch (err: unknown) {
    if (err && typeof err === "object" && "code" in err) {
      if (err.code === 1) return { stdout: "" }
      if (
        err.code === 2 &&
        "stdout" in err &&
        typeof err.stdout === "string"
      ) {
        return { stdout: err.stdout }
      }
    }
    throw err
  }
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const cwd = sp.get("cwd") || process.cwd()
    const query = sp.get("q") || ""
    const caseSensitive = sp.get("caseSensitive") === "true"
    const wholeWord = sp.get("wholeWord") === "true"
    const regex = sp.get("regex") === "true"
    const fileType = sp.get("fileType") || ""

    if (!query) return ok({ results: [], query: "" })

    const stdout = yield* Effect.tryPromise({
      try: () =>
        searchWithRg(RG_PATH, cwd, query, {
          caseSensitive,
          wholeWord,
          regex,
          fileType,
        }).then((r) => r.stdout),
      catch: (cause) =>
        new AppError({ message: "ripgrep search failed", cause }),
    })

    const lines = stdout.split("\n").filter(Boolean)
    const resultsMap = new Map<string, SearchMatch[]>()
    let totalLines = 0

    for (const line of lines) {
      if (totalLines >= MAX_TOTAL_LINES) break
      const match = line.match(/^(?:\.\/)?(.+?):(\d+):(.*)$/)
      if (match) {
        const [, filePath, lineNum, content] = match
        if (!resultsMap.has(filePath)) {
          if (resultsMap.size >= MAX_FILES) continue
          resultsMap.set(filePath, [])
        }
        const matches = resultsMap.get(filePath)!
        if (matches.length >= MAX_MATCHES_PER_FILE) continue
        matches.push({
          lineNumber: parseInt(lineNum, 10),
          content: content.slice(0, 500),
        })
        totalLines++
      }
    }

    const results: SearchResult[] = []
    for (const [path, matches] of resultsMap) {
      results.push({ path, matches })
    }
    results.sort((a, b) => a.path.localeCompare(b.path))

    return ok({
      results,
      query,
      totalFiles: results.length,
      totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
      truncated:
        totalLines >= MAX_TOTAL_LINES || resultsMap.size >= MAX_FILES,
    })
  })
)
