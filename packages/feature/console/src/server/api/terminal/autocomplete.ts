/**
 * /api/terminal/autocomplete — P8+ migration
 *
 * Terminal command/path autocomplete.
 */
import * as fs from "fs/promises"
import * as path from "path"
import { Effect } from "effect"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { ValidationError } from "@cockpit/effect-core"
import {
  expandHomePath,
  isHomeRelativePath,
  HOME_DIR,
} from "@cockpit/shared-utils"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface AutocompleteRequest {
  cwd: string
  input: string
  cursorPosition: number
}

const COMMON_COMMANDS = [
  "ls", "cd", "pwd", "cat", "echo", "mkdir", "rm", "cp", "mv", "touch",
  "git", "npm", "node", "python", "python3", "pip", "cargo", "go",
  "docker", "kubectl", "curl", "wget", "grep", "find", "sed", "awk",
]

async function getPathSuggestions(
  cwd: string,
  partialPath: string
): Promise<string[]> {
  try {
    // A bare `~` has no directory part to re-attach, and completing it against
    // /Users would offer the home directory's own basename (`ka/`) as if it
    // were relative to cwd. Descend into it instead, as a shell does.
    if (isHomeRelativePath(partialPath) && !/[/\\]/.test(partialPath.trim())) {
      return ["~/"]
    }
    // `~/Desk` becomes `<home>/Desk` before anything else looks at it; without
    // this the readdir below hit `<cwd>/~` and every tilde completion came back
    // empty.
    const resolved = expandHomePath(partialPath, HOME_DIR)
    const isAbsolute = resolved.startsWith("/")
    // A trailing separator means "list this directory", not "complete its last
    // segment" — path.basename("/Users/ka/") is "ka", so without this branch
    // `~/<Tab>` offered the home directory's siblings instead of its contents.
    // (expandHomePath preserves the trailing separator for exactly this.)
    const endsWithSep = /[/\\]$/.test(resolved)
    const dirPart = endsWithSep
      ? resolved
      : path.dirname(resolved === "/" ? "/" : resolved)
    const basePath =
      isAbsolute
        ? dirPart
        : endsWithSep || resolved.includes("/")
          ? path.join(cwd, dirPart)
          : cwd
    const prefix = endsWithSep ? "" : path.basename(resolved)
    // Suggestions must be a drop-in replacement for the WHOLE typed word: the
    // caller swaps [replaceStart, replaceEnd) — i.e. all of `partialPath` — for
    // the string returned here. A bare basename therefore threw the directory
    // away, turning `ls ~/Des<Tab>` into `ls Desktop/` (and, long before
    // tildes existed, `ls src/comp<Tab>` into `ls components/`). Re-attach the
    // directory exactly as the user typed it, tilde and all.
    const typedDir = partialPath.slice(
      0,
      Math.max(partialPath.lastIndexOf("/"), partialPath.lastIndexOf("\\")) + 1
    )
    const entries = await fs.readdir(basePath, { withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.name.startsWith(prefix) && !entry.name.startsWith(".")
      )
      .map(
        (entry) =>
          typedDir + (entry.isDirectory() ? `${entry.name}/` : entry.name)
      )
      .slice(0, 20)
  } catch {
    return []
  }
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as Partial<AutocompleteRequest>
    if (!body.cwd || body.input === undefined) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "input",
          reason: "missing",
        })
      )
    }
    const { cwd, input, cursorPosition = 0 } = body
    const beforeCursor = input.substring(0, cursorPosition)
    const words = beforeCursor.split(/\s+/)
    const lastWord = words[words.length - 1] || ""

    const suggestions = yield* Effect.promise(async () => {
      if (words.length === 1 && !beforeCursor.includes(" ")) {
        return COMMON_COMMANDS.filter((cmd) => cmd.startsWith(lastWord))
      }
      return await getPathSuggestions(cwd, lastWord)
    })

    return ok({
      suggestions,
      prefix: lastWord,
      replaceStart: cursorPosition - lastWord.length,
      replaceEnd: cursorPosition,
    })
  })
)
