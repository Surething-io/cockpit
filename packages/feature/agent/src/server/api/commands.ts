/**
 * /api/commands — P8+ migration
 *
 * List builtin + global + project slash commands.
 */
import * as fs from "fs"
import * as path from "path"
import { Effect } from "effect"
import { CLAUDE_DIR, CLAUDE2_DIR } from "@cockpit/shared-utils"
import { handler } from "@cockpit/effect-runtime/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface CommandInfo {
  name: string
  description: string
  source: "builtin" | "global" | "project"
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "/qa", description: "Enter requirements clarification mode", source: "builtin" },
  { name: "/fx", description: "Enter bug evidence-chain analysis mode", source: "builtin" },
  { name: "/commit", description: "Commit code changes", source: "builtin" },
  { name: "/review", description: "Code review", source: "builtin" },
  { name: "/test", description: "Run tests", source: "builtin" },
  { name: "/fix", description: "Fix issues", source: "builtin" },
  { name: "/explain", description: "Explain code", source: "builtin" },
  { name: "/refactor", description: "Refactor code", source: "builtin" },
]

function getDescriptionFromFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, "utf-8")
    const lines = content.split("\n")
    for (const line of lines) {
      const trimmed = line.trim()
      if (trimmed && !trimmed.startsWith("#")) {
        return trimmed.slice(0, 50)
      }
    }
  } catch {
    /* ignore */
  }
  return ""
}

function readCommandsFromDir(
  dir: string,
  source: "global" | "project",
  prefix: string = ""
): CommandInfo[] {
  const commands: CommandInfo[] = []
  if (!fs.existsSync(dir)) return commands
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name
        commands.push(...readCommandsFromDir(entryPath, source, subPrefix))
      } else if (entry.name.endsWith(".md")) {
        const baseName = entry.name.replace(".md", "")
        const name = prefix ? `/${prefix}:${baseName}` : `/${baseName}`
        const description = getDescriptionFromFile(entryPath)
        commands.push({
          name,
          description: description || `Custom command: ${name}`,
          source,
        })
      }
    }
  } catch {
    /* ignore */
  }
  return commands
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    const commands: CommandInfo[] = []

    commands.push(...BUILTIN_COMMANDS)
    commands.push(
      ...readCommandsFromDir(path.join(CLAUDE_DIR, "commands"), "global")
    )
    commands.push(
      ...readCommandsFromDir(path.join(CLAUDE2_DIR, "commands"), "global")
    )
    if (cwd) {
      commands.push(
        ...readCommandsFromDir(
          path.join(cwd, ".claude", "commands"),
          "project"
        )
      )
    }

    // Deduplicate (priority: project > global > builtin)
    const commandMap = new Map<string, CommandInfo>()
    for (const cmd of commands) {
      const existing = commandMap.get(cmd.name)
      if (!existing) {
        commandMap.set(cmd.name, cmd)
      } else {
        const priority = { project: 3, global: 2, builtin: 1 }
        if (priority[cmd.source] > priority[existing.source]) {
          commandMap.set(cmd.name, cmd)
        }
      }
    }

    const result = Array.from(commandMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    )
    return yield* Effect.succeed(
      new Response(JSON.stringify(result), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    )
  })
)
