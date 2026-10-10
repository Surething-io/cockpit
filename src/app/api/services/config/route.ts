/**
 * /api/services/config — P8+ migration
 */
import { Effect } from "effect"
import {
  getServicesConfigPath,
  getGlobalServicesConfigPath,
  readJsonFile,
  writeJsonFile,
  withFileLock,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError, ValidationError } from "@cockpit/effect-core"
import {
  normalizeCustomCommands,
  type CustomCommand,
} from "@cockpit/feature-console/server"

export type { CustomCommand }

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
    const raw = yield* Effect.tryPromise({
      try: () =>
        readJsonFile<Partial<ServicesConfig>>(configPath, {
          customCommands: [],
        }),
      catch: (cause) =>
        new FSError({ path: configPath, op: "read", cause }),
    })
    // Legacy/corrupt entries are upgraded in memory on every read, which is
    // what actually defuses them for consumers. This GET deliberately does NOT
    // write the normalized result back to disk: the read above is not under the
    // file lock, so a write-back of it could land after a concurrent POST and
    // resurrect commands the user had just deleted. Whatever the user edits
    // next persists the normalized shape through POST anyway.
    return ok({ customCommands: normalizeCustomCommands(raw?.customCommands) })
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
    // Under withFileLock like every state-file write (LockedRMWOnly), so it
    // serializes with any read-modify-write of the same file.
    const config: ServicesConfig = {
      customCommands: normalizeCustomCommands(body.customCommands),
    }
    yield* Effect.tryPromise({
      try: () => withFileLock(configPath, () => writeJsonFile(configPath, config)),
      catch: (cause) =>
        new FSError({ path: configPath, op: "write", cause }),
    })
    // Return what was actually persisted, not just `{success:true}`. This POST
    // is the authoritative normalization point — it may rename duplicates and
    // drop unusable entries — so a caller that keeps its optimistic array would
    // silently disagree with disk until the next full reload.
    return ok({ success: true, customCommands: config.customCommands })
  })
)
