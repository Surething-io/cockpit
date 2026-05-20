/**
 * /api/project-settings — P8+ migration
 */
import { Effect } from "effect"
import {
  getProjectSettingsPath,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export const runtime = "nodejs"
export const dynamic = "force-dynamic"

interface ProjectSettings {
  gridLayout?: boolean
  usePty?: boolean
  activeView?: "agent" | "explorer" | "console"
}

const DEFAULT_SETTINGS: ProjectSettings = {
  gridLayout: true,
  usePty: false,
}

export const GET = handler((req) =>
  Effect.gen(function* () {
    const cwd = new URL(req.url).searchParams.get("cwd")
    if (!cwd) {
      return yield* Effect.fail(
        new ValidationError({ field: "cwd", reason: "missing" })
      )
    }
    const settingsPath = getProjectSettingsPath(cwd)
    const settings = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<ProjectSettings>(settingsPath, DEFAULT_SETTINGS),
      catch: (cause) =>
        new FSError({ path: settingsPath, op: "read", cause }),
    })
    return ok({ settings })
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      settings?: ProjectSettings
    }
    if (!body.cwd || !body.settings) {
      return yield* Effect.fail(
        new ValidationError({
          field: !body.cwd ? "cwd" : "settings",
          reason: "missing",
        })
      )
    }
    const { cwd, settings } = body
    const settingsPath = getProjectSettingsPath(cwd)
    yield* Effect.tryPromise({
      try: async () => {
        const existing = await readJsonFile<ProjectSettings>(
          settingsPath,
          DEFAULT_SETTINGS
        )
        await writeJsonFile(settingsPath, { ...existing, ...settings })
      },
      catch: (cause) =>
        new FSError({ path: settingsPath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
