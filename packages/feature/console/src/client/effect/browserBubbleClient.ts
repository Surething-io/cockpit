/**
 * Browser-bubble client IO — Effect wrappers over /api/browser/*.
 */
import { Effect } from "effect"
import { AppError } from "@cockpit/effect-core"

const postBrowserApi = <A>(action: string, body: unknown): Effect.Effect<A, AppError> =>
  Effect.tryPromise({
    try: async () => {
      const res = await fetch(`/api/browser/${action}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      })
      const json = (await res.json()) as { ok?: boolean; data?: A; error?: string }
      if (!res.ok || !json.ok) throw new Error(json.error || `HTTP ${res.status}`)
      return json.data as A
    },
    catch: (cause) =>
      new AppError({ message: cause instanceof Error ? cause.message : `POST /api/browser/${action} failed`, cause }),
  })

/**
 * Open `url` as a real Chrome tab through the OpenCockpit Bridge extension.
 * Fails with the server's guidance when no extension is connected.
 * `cli` is how users address this server (`cockpit` / `cockpit-dev`).
 */
export const openUrlInBrowserTab = (
  url: string,
  cwd: string | undefined,
  show = false,
): Effect.Effect<{ shortId: string; cli?: string }, AppError> =>
  postBrowserApi<{ shortId: string; cli?: string }>("open", { params: { url, tab: true, show, cwd } })
