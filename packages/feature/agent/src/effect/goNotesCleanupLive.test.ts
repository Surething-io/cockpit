import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, existsSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { Effect } from "effect"
import { cleanupGoNotes, goNotesDir } from "./goNotesCleanupLive"

const DAY_MS = 24 * 3600 * 1000
const roots: string[] = []

const makeNotesDir = () => {
  const root = mkdtempSync(join(tmpdir(), "go-notes-"))
  roots.push(root)
  const dir = goNotesDir(root)
  mkdirSync(dir, { recursive: true })
  return dir
}

const writeAged = (file: string, ageDays: number) => {
  writeFileSync(file, "- chose X over Y — to ship, accepting Z\n")
  const t = (Date.now() - ageDays * DAY_MS) / 1000
  utimesSync(file, t, t)
  return file
}

afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

describe("cleanupGoNotes", () => {
  it("resolves to <cockpitDir>/skills/go/notes", () => {
    expect(goNotesDir("/home/me/.cockpit")).toBe(join("/home/me/.cockpit", "skills", "go", "notes"))
  })

  it("removes notes older than the window and keeps fresh ones", async () => {
    const dir = makeNotesDir()
    const old = writeAged(join(dir, "cockpit-old.md"), 31)
    const fresh = writeAged(join(dir, "cockpit-fresh.md"), 29)

    await Effect.runPromise(cleanupGoNotes(dir, 30))

    expect(existsSync(old)).toBe(false)
    expect(existsSync(fresh)).toBe(true)
  })

  it("never touches the skill files beside it, non-markdown files, or subdirectories", async () => {
    const dir = makeNotesDir()
    const skill = writeAged(join(dir, "..", "SKILL.md"), 90)
    const other = writeAged(join(dir, "keep.txt"), 90)
    mkdirSync(join(dir, "sub.md"))

    await Effect.runPromise(cleanupGoNotes(dir, 30))

    expect(existsSync(skill)).toBe(true)
    expect(existsSync(other)).toBe(true)
    expect(existsSync(join(dir, "sub.md"))).toBe(true)
  })

  it("tolerates a missing notes directory", async () => {
    await expect(Effect.runPromise(cleanupGoNotes("/nonexistent/go/notes", 30))).resolves.toBeUndefined()
  })
})
