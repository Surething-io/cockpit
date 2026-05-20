/**
 * /api/services/config — P8+ migration
 */
import { Effect } from "effect"
import {
  getServicesConfigPath,
  getGlobalServicesConfigPath,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"

export interface CustomCommand {
  name: string
  command: string
}

interface ServicesConfig {
  customCommands: CustomCommand[]
}

const resolveConfigPath = (
  cwd: string | null,
  scope: string | null
): string | null =>
  scope === "global"
    ? getGlobalServicesConfigPath()
    : cwd
      ? getServicesConfigPath(cwd)
      : null

export const GET = handler((req) =>
  Effect.gen(function* () {
    const sp = new URL(req.url).searchParams
    const configPath = resolveConfigPath(sp.get("cwd"), sp.get("scope"))
    if (!configPath) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|scope",
          reason: "Missing cwd or scope",
        })
      )
    }
    const config = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<ServicesConfig>(configPath, { customCommands: [] }),
      catch: (cause) =>
        new FSError({ path: configPath, op: "read", cause }),
    })
    return ok(config)
  })
)

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as {
      cwd?: string
      scope?: string
      customCommands?: CustomCommand[]
    }
    const configPath = resolveConfigPath(
      body.cwd ?? null,
      body.scope ?? null
    )
    if (!configPath) {
      return yield* Effect.fail(
        new ValidationError({
          field: "cwd|scope",
          reason: "Missing cwd or scope",
        })
      )
    }
    const config: ServicesConfig = {
      customCommands: body.customCommands || [],
    }
    yield* Effect.tryPromise({
      try: () => writeJsonFile(configPath, config),
      catch: (cause) =>
        new FSError({ path: configPath, op: "write", cause }),
    })
    return ok({ success: true })
  })
)
