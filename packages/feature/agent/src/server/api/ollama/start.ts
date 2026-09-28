/**
 * /api/ollama/start — P8+ migration
 */
import { spawn, execSync } from "child_process"
import { Effect } from "effect"
import { resolveOllamaBaseURL } from "@cockpit/shared-utils"
import { handler, ok } from "@cockpit/effect-runtime/server"
import { AppError, NotFoundError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

async function isOllamaRunning(): Promise<boolean> {
  try {
    // Health-check the configured server (config file > env > default). Note the
    // spawned fallback is always the LOCAL `ollama serve`; a remote baseUrl that
    // is down won't be helped by spawning locally — that boundary is unchanged.
    const base = await resolveOllamaBaseURL()
    const res = await fetch(`${base}/api/tags`, {
      signal: AbortSignal.timeout(2000),
    })
    return res.ok
  } catch {
    return false
  }
}

/**
 * Start `file args` so that it is NOT our child.
 *
 * `detached: true` alone is not enough: it gives the child its own session and
 * process group but keeps it our child, and server.mjs's exit hook kills every
 * direct child (`pkill -P`, or the Windows equivalent). `ollama serve` is a
 * machine-wide service, so a cockpit update/restart/stop must not take it down.
 * A throwaway node process spawns it and exits at once, leaving it orphaned —
 * the same trick bin/pty-host.mjs --launch uses.
 */
function spawnOrphaned(file: string, args: string[]): void {
  const launcher =
    "const [f, a] = JSON.parse(process.argv[1]);" +
    "require('child_process')" +
    ".spawn(f, a, { detached: true, stdio: 'ignore', windowsHide: true })" +
    ".on('error', () => {}).unref()"
  spawn(process.execPath, ["-e", launcher, JSON.stringify([file, args])], {
    detached: true,
    stdio: "ignore",
    windowsHide: true,
  })
    .on("error", () => {})
    .unref()
}

function findOllama(): string | null {
  try {
    return execSync("which ollama", { encoding: "utf-8" }).trim() || null
  } catch {
    return null
  }
}

export const POST = handler(() =>
  Effect.gen(function* () {
    if (yield* Effect.promise(() => isOllamaRunning())) {
      return ok({ status: "already_running" })
    }

    const ollamaPath = findOllama()
    if (!ollamaPath) {
      return yield* Effect.fail(
        new NotFoundError({ resource: "binary", id: "ollama" })
      )
    }

    yield* Effect.sync(() => spawnOrphaned(ollamaPath, ["serve"]))

    // Wait for readiness (up to 8s)
    const started = yield* Effect.promise(async () => {
      for (let i = 0; i < 16; i++) {
        await new Promise((r) => setTimeout(r, 500))
        if (await isOllamaRunning()) return true
      }
      return false
    })

    if (!started) {
      return yield* Effect.fail(
        new AppError({
          message: "Ollama started but not responding yet (timeout)",
        })
      )
    }
    return ok({ status: "started" })
  })
)
