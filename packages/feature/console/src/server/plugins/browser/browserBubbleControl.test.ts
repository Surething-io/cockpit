/**
 * Tests for the CLI-driven browser-bubble lifecycle.
 *
 * The contract under test is the one the UI depends on but cannot assert for
 * itself: `open` must persist an entry the browser plugin can rehydrate AND
 * broadcast the same entry as a console-delta scoped to (projectCwd, tabId) —
 * a UI whose cwd/tabId don't match the broadcast silently ignores it, which
 * looks exactly like "the CLI did nothing".
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing, because paths.ts
 * resolves COCKPIT_DIR once at module load.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const home = mkdtempSync(join(tmpdir(), "cockpit-bubble-test-"))
process.env.COCKPIT_HOME = home

const PROJECT = "/tmp/cockpit-bubble-test-project"
const SUBDIR = join(PROJECT, "packages", "deep")

/** Broadcast frames captured off the fake /ws/global-state client set. */
interface Frame {
  type: string
  cwd: string
  tabId: string
  op: string
  entry?: Record<string, unknown>
  id?: string
}
let sent: Frame[] = []

type ControlModule = typeof import("./browserBubbleControl")
type StoreModule = typeof import("../../terminal/historyStore")
let control: ControlModule
let store: StoreModule
let toShortId: (fullId: string) => string

beforeAll(async () => {
  // The broadcaster reads this exact global (populated by the WS realm in
  // production); a fake socket is enough to observe what a UI would receive.
  ;(globalThis as unknown as { __cockpitGlobalStateClients: Set<unknown> })
    .__cockpitGlobalStateClients = new Set([
    { readyState: 1, send: (d: string) => sent.push(JSON.parse(d)) },
  ])
  control = await import("./browserBubbleControl")
  store = await import("../../terminal/historyStore")
  toShortId = (await import("@cockpit/shared-utils")).toShortId
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

const projectDataDir = join(home, "projects", "-tmp-cockpit-bubble-test-project")

beforeEach(() => {
  sent = []
  // Start every test from an empty history. A project is "known" to cockpit
  // once it has a dir under ~/.cockpit/projects — that is what resolveProjectCwd
  // walks up looking for.
  rmSync(projectDataDir, { recursive: true, force: true })
  mkdirSync(projectDataDir, { recursive: true })
  mkdirSync(SUBDIR, { recursive: true })
})

describe("resolveProjectCwd", () => {
  it("maps a subdirectory to the project that owns it", () => {
    expect(control.resolveProjectCwd(SUBDIR)).toBe(PROJECT)
  })

  it("falls back to the input when no ancestor is a known project", () => {
    const orphan = mkdtempSync(join(tmpdir(), "cockpit-bubble-orphan-"))
    expect(control.resolveProjectCwd(orphan)).toBe(orphan)
    rmSync(orphan, { recursive: true, force: true })
  })
})

describe("openBrowserBubble", () => {
  it("persists a browser entry and broadcasts it to the owning project", async () => {
    const opened = await control.openBrowserBubble({
      cwd: SUBDIR,
      url: "http://localhost:3456",
    })

    // Written under the PROJECT, not the subdirectory the CLI was run from —
    // otherwise no open UI would ever match the delta.
    expect(opened.projectCwd).toBe(PROJECT)
    expect(opened.tabId).toBe(control.CONSOLE_TAB_ID)
    expect(opened.shortId).toBe(toShortId(opened.fullId))

    const entries = await store.readHistoryEntries(PROJECT, opened.tabId)
    expect(entries).toHaveLength(1)
    expect(entries[0]).toMatchObject({
      type: "browser",
      id: opened.fullId,
      url: "http://localhost:3456",
      autoConnect: true,
      // Base for relative urls: the caller's actual cwd, not the project root.
      cwd: SUBDIR,
    })

    expect(sent).toHaveLength(1)
    expect(sent[0]).toMatchObject({
      type: "console-delta",
      cwd: PROJECT,
      tabId: control.CONSOLE_TAB_ID,
      op: "add",
    })
    // The delta must carry the same entry that was persisted — the UI builds
    // the bubble from this payload, not from a re-read of the file.
    expect(sent[0].entry).toMatchObject({
      id: opened.fullId,
      autoConnect: true,
    })
  })

  it("gives every bubble a distinct id", async () => {
    const a = await control.openBrowserBubble({ cwd: PROJECT, url: "http://a" })
    const b = await control.openBrowserBubble({ cwd: PROJECT, url: "http://b" })
    expect(a.fullId).not.toBe(b.fullId)
    expect(a.shortId).not.toBe(b.shortId)
  })
})

describe("findBrowserBubbleByShortId", () => {
  it("resolves a shortId from persisted history when nothing is registered", async () => {
    const opened = await control.openBrowserBubble({
      cwd: PROJECT,
      url: "http://localhost:3456",
    })
    await expect(
      control.findBrowserBubbleByShortId(PROJECT, opened.shortId)
    ).resolves.toBe(opened.fullId)
  })

  it("returns null for an unknown shortId", async () => {
    await control.openBrowserBubble({ cwd: PROJECT, url: "http://localhost" })
    await expect(
      control.findBrowserBubbleByShortId(PROJECT, "zzzz")
    ).resolves.toBeNull()
  })
})

describe("closeBrowserBubble", () => {
  it("removes the entry and broadcasts the delete", async () => {
    const opened = await control.openBrowserBubble({
      cwd: PROJECT,
      url: "http://localhost:3456",
    })
    sent = []

    await expect(
      control.closeBrowserBubble({
        projectCwd: PROJECT,
        tabId: opened.tabId,
        fullId: opened.fullId,
      })
    ).resolves.toBe(true)

    await expect(
      store.readHistoryEntries(PROJECT, opened.tabId)
    ).resolves.toEqual([])
    expect(sent).toEqual([
      expect.objectContaining({
        type: "console-delta",
        cwd: PROJECT,
        tabId: opened.tabId,
        op: "delete",
        id: opened.fullId,
      }),
    ])
  })

  it("still broadcasts when nothing was persisted, so a live bubble goes away", async () => {
    await expect(
      control.closeBrowserBubble({ projectCwd: PROJECT, fullId: "browser-ghost" })
    ).resolves.toBe(false)
    expect(sent).toEqual([
      expect.objectContaining({ op: "delete", id: "browser-ghost" }),
    ])
  })
})
