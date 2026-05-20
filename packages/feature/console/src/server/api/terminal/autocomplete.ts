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
    const isAbsolute = partialPath.startsWith("/")
    const basePath = isAbsolute
      ? path.dirname(partialPath === "/" ? "/" : partialPath)
      : partialPath.includes("/")
        ? path.join(cwd, path.dirname(partialPath))
        : cwd
    const prefix = path.basename(partialPath)
    const entries = await fs.readdir(basePath, { withFileTypes: true })
    return entries
      .filter(
        (entry) => entry.name.startsWith(prefix) && !entry.name.startsWith(".")
      )
      .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name))
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
