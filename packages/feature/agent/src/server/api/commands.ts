/**
 * /api/commands — list builtin slash commands.
 *
 * Used to also enumerate `.md` files under `.claude/commands/` and
 * `~/.claude/commands/` (project + global), mirroring Claude Code's command
 * convention. That convention has been retired, so this endpoint now returns
 * the in-process builtin set only.
 *
 * Each entry MUST have a matching expansion in COMMAND_CONTENT
 * (packages/feature/agent/src/server/lib/slashCommands.ts). Listing a name
 * here without an expansion makes the dropdown advertise a feature that
 * silently no-ops on dispatch.
 */
import { Effect } from "effect"
import { handler } from "@cockpit/effect-runtime/server"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface CommandInfo {
  name: string
  description: string
  source: "builtin" | "skill"
}

const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: "/qa", description: "Enter requirements clarification mode", source: "builtin" },
  { name: "/ap", description: "Enter apply mode: implement <SPEC> while keeping running apply-notes", source: "builtin" },
  { name: "/fx", description: "Enter bug evidence-chain analysis mode", source: "builtin" },
  { name: "/ex", description: "Enter structured analysis & discussion mode", source: "builtin" },
  { name: "/go", description: "Enter landing mode: MVP staged implementation with self-verify", source: "builtin" },
  { name: "/cg", description: "Enter project graph (codegraph) exploration mode", source: "builtin" },
  { name: "/cc", description: "Enter Cockpit CLI (cock subcommands) operation mode", source: "builtin" },
  { name: "/cr", description: "Full code review: static triangulation + dynamic modelling", source: "builtin" },
  { name: "/new-branch", description: "Create a clean new branch off the latest origin/main", source: "builtin" },
  { name: "/skillify", description: "Analyze the conversation for reusable knowledge and distil it into a skill", source: "builtin" },
]

export const GET = handler(() =>
  Effect.succeed(
    new Response(JSON.stringify(BUILTIN_COMMANDS), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })
  )
)
