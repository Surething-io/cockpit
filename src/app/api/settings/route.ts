/**
 * /api/settings — P6 migration
 *
 * Settings read/write; PUT is a merge-update.
 */
import { Effect } from "effect"
import {
  SETTINGS_FILE,
  readJsonFile,
  mutateJsonFile,
} from "@cockpit/shared-utils"
import { handler, ok, parseJsonRaw } from "@cockpit/effect-runtime/server"
import { FSError } from "@cockpit/effect-core"

interface Settings {
  language?: string // 'en' | 'zh' | 'auto'
  [key: string]: unknown
}

// Server-owned keys: never sent to the browser, never written from it.
// `push` held the VAPID key pair in older versions (now push-vapid.json); it can
// still be on disk until push.ts migrates it on first use.
const SERVER_ONLY_KEYS = ["push"]

const forBrowser = (settings: Settings): Settings =>
  Object.fromEntries(
    Object.entries(settings).filter(([k]) => !SERVER_ONLY_KEYS.includes(k))
  )

const readSettings: Effect.Effect<Settings, FSError> = Effect.tryPromise({
  try: () => readJsonFile<Settings>(SETTINGS_FILE, {}),
  catch: (cause) =>
    new FSError({ path: SETTINGS_FILE, op: "read", cause }),
})

export const GET = handler(() =>
  Effect.gen(function* () {
    const settings = yield* readSettings
    return ok(forBrowser(settings))
  })
)

export const PUT = handler((req) =>
  Effect.gen(function* () {
    const patch = forBrowser((yield* parseJsonRaw(req)) as Partial<Settings>)
    // Locked read-merge-write — serializes with push.ts, which also goes through
    // mutateJsonFile(SETTINGS_FILE) when it drops the legacy `push` section.
    const merged = yield* Effect.tryPromise({
      try: () =>
        mutateJsonFile<Settings>(SETTINGS_FILE, {}, (current) => ({
          ...current,
          ...patch,
        })),
      catch: (cause) =>
        new FSError({ path: SETTINGS_FILE, op: "write", cause }),
    })
    return ok(forBrowser(merged))
  })
)
