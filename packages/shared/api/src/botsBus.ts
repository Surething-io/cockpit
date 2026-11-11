/**
 * Cross-frame notification bus for Bot-registry mutations (bot.json).
 *
 * Writers: BotsModal (feature-workspace) and the BOT.md "add" buttons
 * (feature-explorer). Reader: the chat `@` autocomplete (feature-agent).
 * Separate channel from skills so neither registry reloads the other.
 */
import { createChangeBus } from "./changeBus"

const bus = createChangeBus("cockpit-bots", "/api/bots")

export const notifyBotsChanged = bus.notify
export const onBotsChanged = bus.subscribe
