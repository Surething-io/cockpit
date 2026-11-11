/**
 * Client-side Bot-registry IO (bot.json). Endpoints:
 *   - GET    /api/bots       — list
 *   - POST   /api/bots       — register a Bot directory or its BOT.md
 *   - DELETE /api/bots/:id   — remove the registration (files are kept)
 *
 * Shared because feature-workspace (BotsModal), feature-explorer (BOT.md
 * "add" buttons) and feature-agent (`@` autocomplete) all use it.
 */
import { Effect } from "effect"
import { AppError, forgetInFlight, shareInFlight } from "@cockpit/effect-core"
import { httpJson, postJson } from "./httpJson"

interface BotBase {
  readonly id: string
  readonly path: string
  readonly addedAt: string
  /** From BOT.md, or the directory name when BOT.md is unusable. */
  readonly name: string
  /**
   * Shipped under /bots and merged in at read time — not stored in bot.json, so
   * it cannot be removed. Absent on registered Bots.
   *
   * `path` is NOT the install root: a built-in is installed into
   * ~/.cockpit/bots/<name> on first listing and `path` is that copy, so it can
   * be opened and edited like any other Bot (see builtinBots.ts).
   */
  readonly builtin?: boolean
}

/** Mirrors the server's BotSummary: a usable Bot, or why it is not. */
export type BotInfo =
  | (BotBase & { readonly valid: true; readonly description: string })
  | (BotBase & { readonly valid: false; readonly error: string })

export type AddBotResult = BotInfo & {
  /** True when the directory was already registered (no new entry written). */
  readonly alreadyExists: boolean
}

export const loadBots = (): Effect.Effect<ReadonlyArray<BotInfo>, AppError> =>
  shareInFlight("/api/bots", httpJson<ReadonlyArray<BotInfo>>("/api/bots"))

/** Pending /api/bots reads must not be joined once a write has landed. */
const forgetBots = Effect.sync(() => forgetInFlight("/api/bots"))

export const addBot = (path: string): Effect.Effect<AddBotResult, AppError> =>
  postJson<AddBotResult>("/api/bots", { path }).pipe(Effect.ensuring(forgetBots))

export const removeBot = (id: string): Effect.Effect<unknown, AppError> =>
  httpJson(`/api/bots/${encodeURIComponent(id)}`, { method: "DELETE" }).pipe(Effect.ensuring(forgetBots))
