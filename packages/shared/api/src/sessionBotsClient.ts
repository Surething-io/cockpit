/**
 * Client-side session-Bot IO — sessions ticked "can be @-mentioned" in the title dialog,
 * listed with the Bots and addressed as `@<title>`. Endpoints:
 *   - GET    /api/session-bots                      — list
 *   - DELETE /api/session-bots  { cwd, sessionId }  — remove (the session is kept)
 * Adding is a title-dialog save (POST /api/session-title { mentionable: true }).
 *
 * Shared because feature-workspace (BotsModal) and feature-agent (`@` autocomplete, the
 * title dialog) all use it. Changes are announced on the same bus as Bots (botsBus).
 */
import { Effect } from "effect"
import { AppError, forgetInFlight, shareInFlight } from "@cockpit/effect-core"
import { httpJson } from "./httpJson"

/** Mirrors the server's SessionBotInfo (feature-agent server/lib/sessionBots). */
export interface SessionBotInfo {
  readonly cwd: string
  readonly sessionId: string
  readonly addedAt: string
  /** The session's current title. */
  readonly title: string
  /** The `@` name, or null when the title cannot be one (see `problem`). */
  readonly name: string | null
  readonly problem: "empty" | "multiline" | "at" | null
  /** null when the session's transcript is gone. */
  readonly engine: string | null
}

export const loadSessionBots = (): Effect.Effect<ReadonlyArray<SessionBotInfo>, AppError> =>
  shareInFlight("/api/session-bots", httpJson<ReadonlyArray<SessionBotInfo>>("/api/session-bots"))

/** Pending reads must not be joined once a write has landed. */
export const forgetSessionBots = Effect.sync(() => forgetInFlight("/api/session-bots"))

export const removeSessionBot = (cwd: string, sessionId: string): Effect.Effect<unknown, AppError> =>
  httpJson("/api/session-bots", {
    method: "DELETE",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cwd, sessionId }),
  }).pipe(Effect.ensuring(forgetSessionBots))
