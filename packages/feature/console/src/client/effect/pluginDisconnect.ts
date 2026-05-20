/**
 * Plugin client helpers — shared fetch → Effect wrappers used by DB bubble plugins.
 *
 * Provides three categories of helpers:
 *  - `disconnectPluginBubble` / `shutdownJupyterKernel` — plugin/<name>/index.tsx close callbacks
 *  - `pluginApiPost` — internal business POST inside Bubble.tsx (query/export/CRUD); returns the JSON body or throws Error
 */
import { Effect } from "effect"
import { BrowserRuntime } from "@cockpit/effect-runtime"
import { AppError } from "@cockpit/effect-core"

const httpPostJson = (
  url: string,
  body: unknown
): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
    },
    catch: (cause) =>
      new AppError({ message: `POST ${url} failed`, cause }),
  })

/**
 * Close a DB bubble: fire-and-forget POST `/api/<plugin>/disconnect { id }`.
 * Failures are swallowed by orElse (matching the original silent `try {...} catch {}` behavior).
 */
export const disconnectPluginBubble = (
  plugin: "db" | "mysql" | "redis" | "neo4j",
  id: string
): Promise<void> =>
  BrowserRuntime.runPromise(
    httpPostJson(`/api/${plugin}/disconnect`, { id }).pipe(
      Effect.orElse(() => Effect.void)
    )
  )

/**
 * Jupyter kernel uses its own endpoint POST /api/jupyter/shutdown { bubbleId }.
 */
export const shutdownJupyterKernel = (
  bubbleId: string
): Promise<void> =>
  BrowserRuntime.runPromise(
    httpPostJson("/api/jupyter/shutdown", { bubbleId }).pipe(
      Effect.orElse(() => Effect.void)
    )
  )

/**
 * Unregister a browser bubble: `POST /api/browser/unregister { id }`, fire-and-forget.
 */
export const unregisterBrowserBridge = (id: string): Promise<void> =>
  BrowserRuntime.runPromise(
    httpPostJson("/api/browser/unregister", { id }).pipe(
      Effect.orElse(() => Effect.void)
    )
  )

/**
 * Generic POST helper for internal business calls inside Bubble.tsx: returns the JSON body or throws Error
 * (matches the original `apiPost` behavior: when !res.ok, throw Error(data.error || HTTP n)).
 *
 * Original shape:
 *   async function apiPost(path, body) {
 *     const res = await fetch(...)
 *     const data = await res.json()
 *     if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
 *     return data
 *   }
 */
/**
 * Unwrap an Effect failure back to the underlying Error and rethrow it, preserving
 * the `try { ... } catch (err) { err.message }` ergonomics of the original code.
 */
const reThrowInnerError = <A>(eff: Effect.Effect<A, AppError>): Promise<A> =>
  BrowserRuntime.runPromise(
    eff.pipe(
      Effect.catchAll((err) =>
        Effect.sync<A>(() => {
          if (err.cause instanceof Error) throw err.cause
          throw new Error(err.message)
        })
      )
    )
  )

/**
 * Note: `A = any` is intentional — the original `apiPost` returned any-like data
 * (callers access `data.error / data.rows / data.fields` directly). The Effect-wrapped
 * version preserves the same call-site ergonomics so Bubble code doesn't need wholesale
 * type-annotation changes.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pluginApiPost = <A = any>(
  path: string,
  body: Record<string, unknown>
): Promise<A> =>
  reThrowInnerError(
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        const data = await res.json()
        if (!res.ok)
          throw new Error(
            (data as { error?: string })?.error || `HTTP ${res.status}`
          )
        return data as A
      },
      catch: (cause) => new AppError({ message: `POST ${path} failed`, cause }),
    })
  )

/**
 * Like apiPost but uses GET, with the query string built from `params`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const pluginApiGet = <A = any>(
  path: string,
  params: Record<string, string>
): Promise<A> =>
  reThrowInnerError(
    Effect.tryPromise({
      try: async () => {
        const sp = new URLSearchParams(params)
        const res = await fetch(`${path}?${sp}`)
        const data = await res.json()
        if (!res.ok)
          throw new Error(
            (data as { error?: string })?.error || `HTTP ${res.status}`
          )
        return data as A
      },
      catch: (cause) => new AppError({ message: `GET ${path} failed`, cause }),
    })
  )

/**
 * POST that returns a binary blob (CSV / JSON file export download scenarios).
 * On !res.ok, throws Error('<inferred message>') without attempting JSON parsing.
 */
export const pluginApiPostBlob = (
  path: string,
  body: Record<string, unknown>
): Promise<Blob> =>
  reThrowInnerError(
    Effect.tryPromise({
      try: async () => {
        const res = await fetch(path, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        return res.blob()
      },
      catch: (cause) =>
        new AppError({ message: `POST blob ${path} failed`, cause }),
    })
  )
