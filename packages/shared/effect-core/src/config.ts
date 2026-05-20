/**
 * Config Layer — Cockpit typed configuration
 *
 * External libraries such as dotenv are intentionally not used. process.env is
 * read directly (Effect's default ConfigProvider already handles this).
 * Business code:
 *   const cfg = yield* CockpitConfig
 *   const port = cfg.port
 *
 * The Layer does not need to be provided (Config is an ambient effect supplied
 * via the ConfigProvider Layer), but `CockpitConfig` is exported in Effect form
 * so business code can `yield*` it to obtain the typed config.
 *
 * Notes:
 *  - `homedir()` / `join()` / other Node-only APIs must not be called during
 *    module evaluation.
 *  - effect-core is imported into the browser bundle (BrowserLayer → ConfigLive).
 *  - The browser bundle replaces `os` with an empty stub, so any module-eval
 *    call would crash at runtime.
 *  - Resolution: lazily defer all Node API calls into Effect.gen so they run
 *    only inside the real server runtime.
 */
import { Config, Effect, Layer } from "effect"

// ─────────────────────────────────────────────────────────
// Typed configuration definition — single source of truth
// ─────────────────────────────────────────────────────────

export interface CockpitConfigData {
  /** dev | prod */
  readonly env: "dev" | "prod"
  /** WS / HTTP bind host */
  readonly host: string
  /** HTTP port */
  readonly port: number
  /** ~/.cockpit root directory */
  readonly cockpitDir: string
  /** Project to open on startup (COCKPIT_OPEN_PROJECT) */
  readonly openProject: string | undefined
  /** Whether to open the browser on startup (inverse of COCKPIT_NO_OPEN) */
  readonly openBrowser: boolean
  /** Log level (COCKPIT_LOG_LEVEL) */
  readonly logLevel: string
  /** Log file path (derived from cockpitDir) */
  readonly logFile: string
}

const envConfig = Config.literal("dev", "prod")("COCKPIT_ENV").pipe(
  Config.withDefault("prod" as const)
)

const hostConfig = Config.string("COCKPIT_HOST").pipe(
  Config.withDefault("127.0.0.1")
)

// Prefer `COCKPIT_PORT` (the legacy v1 variable name hard-coded by
// scheduledTasks / review/share-info), falling back to `PORT`. Final defaults
// are 3457 (prod) / 3456 (dev, derived below).
const portConfig = Config.integer("COCKPIT_PORT").pipe(
  Config.orElse(() => Config.integer("PORT")),
  Config.withDefault(3457)
)

const openProjectConfig = Config.option(
  Config.string("COCKPIT_OPEN_PROJECT")
).pipe(
  Config.map((opt) => (opt._tag === "Some" ? opt.value : undefined))
)

const noOpenConfig = Config.boolean("COCKPIT_NO_OPEN").pipe(
  Config.withDefault(false)
)

const logLevelConfig = Config.string("COCKPIT_LOG_LEVEL").pipe(
  Config.withDefault("info")
)

// cockpitDir cannot be evaluated at the module top level (it would call
// os.homedir, which crashes against the browser stub). Resolve it lazily:
// Config.string("COCKPIT_DIR") returns an Option, then inside Effect.gen a
// dynamic import resolves homedir() when needed.
const cockpitDirConfigOpt = Config.option(Config.string("COCKPIT_DIR"))

// ─────────────────────────────────────────────────────────
// Composition
// ─────────────────────────────────────────────────────────

export const CockpitConfig: Effect.Effect<CockpitConfigData> = Effect.gen(
  function* () {
    const env = yield* envConfig
    const host = yield* hostConfig
    const port = yield* portConfig
    const openProject = yield* openProjectConfig
    const noOpen = yield* noOpenConfig
    const logLevel = yield* logLevelConfig

    // cockpitDir: lazy resolution to avoid Node-only os.homedir at module eval.
    // Use process.env.HOME / USERPROFILE instead of os.homedir() — zero
    // dependencies and safe on the browser (the stub returns undefined, which
    // falls back to "/.cockpit"; the browser path barely consumes cockpitDir
    // anyway).
    const cockpitDirOpt = yield* cockpitDirConfigOpt
    const cockpitDir = yield* Effect.sync(() => {
      if (cockpitDirOpt._tag === "Some") return cockpitDirOpt.value
      const env =
        typeof process !== "undefined" ? process.env : undefined
      const home =
        env?.HOME ||
        env?.USERPROFILE ||
        "."
      return home + "/.cockpit"
    })

    // logFile is derived (plain string concatenation, no Node API)
    const logFile = cockpitDir + "/logs/cockpit.log"

    return {
      env,
      host,
      port: port === 3457 && env === "dev" ? 3456 : port, // dev defaults to 3456
      cockpitDir,
      openProject,
      openBrowser: !noOpen,
      logLevel,
      logFile,
    } satisfies CockpitConfigData
  }
).pipe(Effect.orDie) // Treat Config validation failures as defects (exit at startup)

// ─────────────────────────────────────────────────────────
// Layer placeholder — Config is an ambient effect, no `provide` required.
// The Layer exists so AppLayer can explicitly declare "Cockpit Config enabled".
// ─────────────────────────────────────────────────────────

export const ConfigLive: Layer.Layer<never> = Layer.empty
