/**
 * Route-level tests for /api/services/config.
 *
 * These cover the half that unit tests on normalizeCustomCommands cannot: the
 * GET must NOT write to disk (a read with a write side effect raced against
 * POST and could resurrect deleted commands), and the POST must echo back the
 * commands as actually persisted so the client cannot drift from disk.
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing the route, because
 * paths.ts resolves COCKPIT_DIR once at module load.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from "vitest"
import { mkdtempSync, rmSync, mkdirSync, writeFileSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"

const home = mkdtempSync(join(tmpdir(), "cockpit-route-test-"))
process.env.COCKPIT_HOME = home

const PROJECT = "/tmp/cockpit-route-test-project"
const configDir = join(home, "projects", "-tmp-cockpit-route-test-project")
const configPath = join(configDir, "services.json")

// Imported dynamically so the env var above is in place first.
let GET: (req: Request) => Promise<Response>
let POST: (req: Request) => Promise<Response>

beforeAll(async () => {
  const mod = await import("../../../../../../src/app/api/services/config/route")
  GET = mod.GET as typeof GET
  POST = mod.POST as typeof POST
})

afterAll(() => rmSync(home, { recursive: true, force: true }))

beforeEach(() => {
  mkdirSync(configDir, { recursive: true })
})

const url = `http://localhost/api/services/config?cwd=${encodeURIComponent(PROJECT)}`
const onDisk = () => readFileSync(configPath, "utf-8")

describe("GET /api/services/config", () => {
  it("normalizes legacy bare strings in the response", async () => {
    writeFileSync(
      configPath,
      JSON.stringify({ customCommands: ["open https://x", "npm run dev"] })
    )
    const body = await (await GET(new Request(url))).json()
    expect(body.customCommands).toEqual([
      { name: "open", command: "open https://x" },
      { name: "npm", command: "npm run dev" },
    ])
  })

  it("does NOT write the normalized result back to disk", async () => {
    const legacy = JSON.stringify({ customCommands: ["open https://x"] })
    writeFileSync(configPath, legacy)
    for (let i = 0; i < 3; i++) await GET(new Request(url))
    expect(onDisk()).toBe(legacy)
  })

  it("survives a config whose parent dir is missing", async () => {
    rmSync(configDir, { recursive: true, force: true })
    const res = await GET(new Request(url))
    expect(res.status).toBe(200)
    expect((await res.json()).customCommands).toEqual([])
  })
})

describe("POST /api/services/config", () => {
  const post = (customCommands: unknown) =>
    POST(
      new Request("http://localhost/api/services/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ cwd: PROJECT, customCommands }),
      })
    )

  it("echoes back what was persisted, not what was sent", async () => {
    const res = await post([
      { name: "build", command: "a" },
      { name: "build", command: "b" },
      { name: "", command: "" },
    ])
    const body = await res.json()
    expect(body.customCommands).toEqual([
      { name: "build", command: "a" },
      { name: "build-2", command: "b" },
    ])
    expect(JSON.parse(onDisk()).customCommands).toEqual(body.customCommands)
  })

  it("round-trips: what POST returns is what the next GET reports", async () => {
    const posted = (await (await post([{ name: "x", command: "ls" }])).json())
      .customCommands
    const fetched = (await (await GET(new Request(url))).json()).customCommands
    expect(fetched).toEqual(posted)
  })
})
