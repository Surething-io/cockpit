import { describe, it, expect } from "vitest"
import { normalizeCustomCommands } from "./services-config"

describe("normalizeCustomCommands", () => {
  it("passes through well-formed entries untouched", () => {
    const input = [{ name: "dev", command: "npm run dev" }]
    expect(normalizeCustomCommands(input)).toEqual(input)
  })

  it("upgrades legacy bare strings, deriving a name from the command", () => {
    expect(
      normalizeCustomCommands([
        "open https://admin.knowi.me/dashboard/chats/f5cc",
        "stripe listen --forward-to localhost:3001/api/webhooks/stripe",
      ])
    ).toEqual([
      {
        name: "open",
        command: "open https://admin.knowi.me/dashboard/chats/f5cc",
      },
      {
        name: "stripe",
        command:
          "stripe listen --forward-to localhost:3001/api/webhooks/stripe",
      },
    ])
  })

  it("uses the host for bare URLs instead of the whole URL", () => {
    expect(normalizeCustomCommands(["http://localhost:3000"])).toEqual([
      { name: "localhost3000", command: "http://localhost:3000" },
    ])
  })

  it("de-duplicates derived names", () => {
    const out = normalizeCustomCommands(["open a", "open b", "open c"])
    expect(out.map((c) => c.name)).toEqual(["open", "open-2", "open-3"])
  })

  it("drops entries with no usable command", () => {
    expect(
      normalizeCustomCommands([
        "",
        "   ",
        null,
        42,
        {},
        { name: "x" },
        { name: "y", command: "" },
      ])
    ).toEqual([])
  })

  it("backfills a missing name on an object entry", () => {
    expect(normalizeCustomCommands([{ command: "npm run build" }])).toEqual([
      { name: "npm", command: "npm run build" },
    ])
  })

  it("sanitizes a user-supplied name to what slash completion can match", () => {
    // Slash completion matches the first word after `/`, so a name with a
    // space could be stored and shown but never invoked.
    expect(normalizeCustomCommands([{ name: "my cmd", command: "ls" }])).toEqual(
      [{ name: "mycmd", command: "ls" }]
    )
    expect(
      normalizeCustomCommands([{ name: "a/b'c\"d", command: "ls" }])
    ).toEqual([{ name: "abcd", command: "ls" }])
  })

  it("derives a name when the supplied one sanitizes to nothing", () => {
    expect(normalizeCustomCommands([{ name: "!!!", command: "ls -la" }])).toEqual(
      [{ name: "ls", command: "ls -la" }]
    )
  })

  it("never produces an empty name (unmatchable and unremovable)", () => {
    const out = normalizeCustomCommands([{ name: "###", command: "!!!" }])
    expect(out).toEqual([{ name: "command", command: "!!!" }])
  })

  it("truncates an over-long name", () => {
    const [only] = normalizeCustomCommands([
      { name: "x".repeat(80), command: "ls" },
    ])
    expect(only.name).toHaveLength(32)
  })

  it("returns [] for non-array input", () => {
    expect(normalizeCustomCommands(undefined)).toEqual([])
    expect(normalizeCustomCommands(null)).toEqual([])
    expect(normalizeCustomCommands("nope")).toEqual([])
    expect(normalizeCustomCommands({ customCommands: [] })).toEqual([])
  })

  it("is idempotent", () => {
    const once = normalizeCustomCommands(["open https://x", "http://y:1"])
    expect(normalizeCustomCommands(once)).toEqual(once)
  })
})
