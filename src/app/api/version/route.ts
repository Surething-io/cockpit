/**
 * /api/version — P6 migration
 *
 * Returns the cockpit package version (read from COCKPIT_ROOT/package.json), plus the versions
 * of the agent CLIs bundled with it.
 *
 * The agent versions are diagnostic only, and deliberately carry no "newer available" check:
 * both CLIs ship inside their SDKs at an exactly pinned version, so the only way a user moves
 * to a newer Claude or Codex is a Cockpit release that bumped the pin. Telling them a newer CLI
 * exists would advertise an action they cannot take. What this DOES answer is "which Claude am
 * I actually running", which is otherwise invisible when a bug report comes in.
 */
import { readFileSync } from "fs"
import { join } from "path"
import { Effect } from "effect"
import { handler, ok } from "@cockpit/effect-runtime/server"

export const runtime = "nodejs"

/** Read a JSON field off a package in node_modules; null when absent or unreadable.
 *  Read by path rather than require.resolve: both SDKs declare an `exports` map with no
 *  `./package.json` entry, so resolution fails with ERR_PACKAGE_PATH_NOT_EXPORTED. */
const packageField = (root: string, pkg: string, field: string): string | null => {
  try {
    const meta = JSON.parse(
      readFileSync(join(root, "node_modules", ...pkg.split("/"), "package.json"), "utf-8")
    ) as Record<string, unknown>
    const value = meta[field]
    return typeof value === "string" ? value : null
  } catch {
    return null
  }
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const root = process.env.COCKPIT_ROOT || process.cwd()
    const version = yield* Effect.try({
      try: () => {
        const pkg = JSON.parse(
          readFileSync(join(root, "package.json"), "utf-8")
        ) as { version?: string }
        return pkg.version ?? ""
      },
      // Return empty version on missing file / parse failure (v1 behavior)
      catch: () => null,
    }).pipe(Effect.orElseSucceed(() => ""))

    // Claude's CLI has no package of its own here — the SDK declares the build it ships in
    // `claudeCodeVersion`. Codex's CLI IS a package (`@openai/codex-sdk` pins it exactly), so
    // read that package's own version rather than inferring it from the SDK's.
    const claude = packageField(root, "@anthropic-ai/claude-agent-sdk", "claudeCodeVersion")
    const codex = packageField(root, "@openai/codex", "version")

    return ok({ version, agents: { claude, codex } })
  })
)
