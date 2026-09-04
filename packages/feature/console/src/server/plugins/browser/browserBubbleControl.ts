/**
 * Console browser-bubble lifecycle, driven from outside the UI.
 *
 * `cockpit browser open <url>` / `cockpit browser <id> close` need to create
 * and destroy bubbles that no human clicked into existence. Both reuse the
 * machinery the console already has rather than inventing a control channel:
 *
 *   append/remove the tab's history entry  →  broadcastConsoleDelta
 *   →  every open UI applies the delta  →  bubble mounts / unmounts
 *
 * Consequences worth knowing before touching this:
 *
 * - With no UI connected the delta lands nowhere. The entry is still persisted,
 *   so the bubble appears the next time the project is opened — `open` reports
 *   `registered: false` for that case instead of pretending it succeeded.
 * - `close` only deletes the history entry. The bubble's bridge WS must be left
 *   to die with the unmounting component; force-closing it server-side would
 *   just trip the client's 3s reconnect.
 */
import { existsSync } from "fs"
import { dirname, resolve } from "path"
import { getCockpitProjectDir, toShortId } from "@cockpit/shared-utils"
import {
  appendHistoryEntry,
  removeHistoryEntry,
  readHistoryEntries,
} from "../../terminal/historyStore"
import { broadcastConsoleDelta } from "../../terminal/consoleBroadcast"

/**
 * The console is a per-project singleton: TabManager mounts ConsoleView with a
 * hard-coded `tabId="default"`, which is what scopes the history file and the
 * delta broadcast. Named here so the CLI path and the UI cannot drift onto two
 * different history files.
 */
export const CONSOLE_TAB_ID = "default"

/**
 * Map any directory to the project that owns it.
 *
 * The CLI is typically run from a subdirectory, but a delta is only applied by
 * a UI whose `cwd` matches exactly — so writing the bubble under the raw cwd
 * would silently produce nothing. Walk up to the nearest ancestor cockpit knows
 * as a project; fall back to the input when there is no such ancestor.
 */
export function resolveProjectCwd(cwd: string): string {
  const start = resolve(cwd)
  let dir = start
  for (;;) {
    if (existsSync(getCockpitProjectDir(dir))) return dir
    const parent = dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

export interface OpenedBubble {
  fullId: string
  shortId: string
  projectCwd: string
  tabId: string
}

/**
 * Create a browser bubble in `cwd`'s project and ask it to register its bridge
 * on mount (`autoConnect`), so `cockpit browser <shortId> …` works without a
 * manual click on the bubble's shortId badge.
 */
export async function openBrowserBubble(opts: {
  cwd: string
  url: string
  tabId?: string
}): Promise<OpenedBubble> {
  const projectCwd = resolveProjectCwd(opts.cwd)
  const tabId = opts.tabId ?? CONSOLE_TAB_ID
  // Same shape as the client's generatePluginItemId('browser') — shortId is
  // toShortId(fullId), so the caller can print it before the bubble exists.
  const fullId = `browser-${Date.now()}-${Math.random()
    .toString(36)
    .slice(2, 8)}`

  const entry = {
    type: "browser" as const,
    id: fullId,
    timestamp: new Date().toISOString(),
    url: opts.url,
    // Base for a RELATIVE url. Deliberately the caller's raw cwd, not
    // projectCwd: `cockpit browser open ./report.html` should resolve against
    // the directory the user is standing in, mirroring what typing the same
    // path into the console after a `cd` does.
    cwd: resolve(opts.cwd),
    autoConnect: true,
  }

  await appendHistoryEntry(projectCwd, tabId, entry)
  broadcastConsoleDelta(projectCwd, tabId, { op: "add", entry })

  return { fullId, shortId: toShortId(fullId), projectCwd, tabId }
}

/** Destroy a bubble: drop its history entry and tell every open UI to unmount it. */
export async function closeBrowserBubble(opts: {
  projectCwd: string
  tabId?: string
  fullId: string
}): Promise<boolean> {
  const tabId = opts.tabId ?? CONSOLE_TAB_ID
  const removed = await removeHistoryEntry(opts.projectCwd, tabId, opts.fullId)
  // Broadcast even when nothing was persisted — a live bubble still has to go.
  broadcastConsoleDelta(opts.projectCwd, tabId, {
    op: "delete",
    id: opts.fullId,
  })
  return !!removed
}

/**
 * Find a browser bubble's fullId from its shortId by scanning persisted
 * history. Only needed when the bubble is not in the in-process registry —
 * i.e. nothing is driving it — which is exactly when `close` still has to work.
 */
export async function findBrowserBubbleByShortId(
  projectCwd: string,
  shortId: string,
  tabId: string = CONSOLE_TAB_ID
): Promise<string | null> {
  const entries = await readHistoryEntries(projectCwd, tabId)
  for (const e of entries) {
    if (e.type === "browser" && e.id && toShortId(e.id) === shortId) return e.id
  }
  return null
}
