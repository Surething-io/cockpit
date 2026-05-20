/**
 * /api/settings — P6 migration
 *
 * Settings read/write; PUT is a merge-update.
 */
import { Effect } from "effect"
import {
  SETTINGS_FILE,
  readJsonFile,
  writeJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"

interface Settings {
  language?: string // 'en' | 'zh' | 'auto'
  [key: string]: unknown
}

const readSettings: Effect.Effect<Settings, FSError> = Effect.tryPromise({
  try: () => readJsonFile<Settings>(SETTINGS_FILE, {}),
  catch: (cause) =>
    new FSError({ path: SETTINGS_FILE, op: "read", cause }),
})

const writeSettings = (data: Settings): Effect.Effect<void, FSError> =>
  Effect.tryPromise({
    try: () => writeJsonFile(SETTINGS_FILE, data),
    catch: (cause) =>
      new FSError({ path: SETTINGS_FILE, op: "write", cause }),
  })

export const GET = handler(() =>
  Effect.gen(function* () {
    const settings = yield* readSettings
    return ok(settings)
  })
)

export const PUT = handler((req) =>
  Effect.gen(function* () {
    const patch = (yield* parseJsonRaw(req)) as Partial<Settings>
    const current = yield* readSettings
    const merged = { ...current, ...patch }
    yield* writeSettings(merged)
    return ok(merged)
  })
)
