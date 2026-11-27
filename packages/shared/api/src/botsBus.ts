/**
 * Cross-frame notification bus for Bot-registry mutations (bot.json).
 *
 * Writers: BotsModal (feature-workspace) and the BOT.md "add" buttons
 * (feature-explorer). Reader: the chat `@` autocomplete (feature-agent).
 * Separate channel from skills so neither registry reloads the other.
 *
 * Session Bots (sessionBotsClient) are announced here too — `@` treats both as one list —
 * so a change forgets in-flight reads of BOTH registries; otherwise a frame refreshing on
 * the event could join a session-Bot read that started before the write.
 */
import { createChangeBus } from "./changeBus"

const bus = createChangeBus("cockpit-bots", ["/api/bots", "/api/session-bots"])

export const notifyBotsChanged = bus.notify
export const onBotsChanged = bus.subscribe
