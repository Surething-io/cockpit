/**
 * Tests for normalizeInstructions — the one place quick-instruction data is validated.
 *
 * Everything here is a silent failure mode: the popover just renders whatever
 * survives, so a dropped instruction, a resurrected duplicate or two rows sharing an
 * id all look like "the UI is being weird" rather than like a parser bug. The
 * backward-compatibility cases matter most — real users have a pre-group
 * `prompts: string[]` file on disk right now, under the feature's OLD name.
 */
import { describe, it, expect } from "vitest"
import { normalizeInstructions, isInstructionGroup, pickTree } from "./instructions-config"
import type { InstructionGroup, InstructionItem } from "./instructions-config"

const items = (nodes: ReturnType<typeof normalizeInstructions>): InstructionItem[] =>
  nodes.filter((n) => !isInstructionGroup(n)) as InstructionItem[]
const groups = (nodes: ReturnType<typeof normalizeInstructions>): InstructionGroup[] =>
  nodes.filter(isInstructionGroup) as InstructionGroup[]
const texts = (nodes: ReturnType<typeof normalizeInstructions>): string[] =>
  items(nodes).map((i) => i.text)

/** Every id in the tree, root and nested. */
const allIds = (nodes: ReturnType<typeof normalizeInstructions>): string[] =>
  nodes.flatMap((n) => (isInstructionGroup(n) ? [n.id, ...n.items.map((i) => i.id)] : [n.id]))

describe("normalizeInstructions — legacy string[] compatibility", () => {
  it("reads a pre-group file as an all-loose root, in order", () => {
    const out = normalizeInstructions(["rebase origin main", "用中文重新回答"])
    expect(groups(out)).toHaveLength(0)
    expect(texts(out)).toEqual(["rebase origin main", "用中文重新回答"])
  })

  it("issues an id to every legacy string", () => {
    const out = normalizeInstructions(["a", "b"])
    expect(allIds(out).every((id) => id.length > 0)).toBe(true)
  })

  it("returns [] for anything that is not an array", () => {
    expect(normalizeInstructions(undefined)).toEqual([])
    expect(normalizeInstructions(null)).toEqual([])
    expect(normalizeInstructions({ instructions: ["a"] })).toEqual([])
    expect(normalizeInstructions("a")).toEqual([])
  })
})

describe("normalizeInstructions — item hygiene", () => {
  it("drops non-strings instead of stringifying them", () => {
    // A stray null rendered as "null" would be a sendable instruction nobody wrote.
    const out = normalizeInstructions(["ok", null, 42, undefined, {}, [], true])
    expect(texts(out)).toEqual(["ok"])
  })

  it("trims, and drops entries that are blank once trimmed", () => {
    expect(texts(normalizeInstructions(["  padded  ", "   ", "\n\t"]))).toEqual(["padded"])
  })

  it("truncates at 2000 chars", () => {
    const out = normalizeInstructions(["x".repeat(2500)])
    expect(texts(out)[0]).toHaveLength(2000)
  })
})

describe("normalizeInstructions — dedupe is per scope", () => {
  it("collapses duplicate text among loose root instructions", () => {
    expect(texts(normalizeInstructions(["a", "a", "b"]))).toEqual(["a", "b"])
  })

  it("collapses duplicate text within one group", () => {
    const out = normalizeInstructions([{ name: "G", items: ["a", "a", "b"] }])
    expect(groups(out)[0].items.map((i) => i.text)).toEqual(["a", "b"])
  })

  it("KEEPS the same text filed under two different groups", () => {
    // The whole point of groups: filing one instruction in two places is a choice,
    // not a mistake. Global dedupe would silently delete the second copy.
    const out = normalizeInstructions([
      { name: "G1", items: ["shared"] },
      { name: "G2", items: ["shared"] },
    ])
    expect(groups(out).map((g) => g.items.map((i) => i.text))).toEqual([["shared"], ["shared"]])
  })

  it("keeps a loose instruction whose text also lives inside a group", () => {
    const out = normalizeInstructions(["shared", { name: "G", items: ["shared"] }])
    expect(texts(out)).toEqual(["shared"])
    expect(groups(out)[0].items).toHaveLength(1)
  })
})

describe("normalizeInstructions — ids are unique tree-wide", () => {
  it("reissues colliding ids across groups", () => {
    // The UI addresses drag targets and open editors by id; two rows sharing
    // one would move or save each other's row.
    const out = normalizeInstructions([
      { id: "dup", name: "G1", items: [{ id: "dup", text: "a" }] },
      { id: "dup", name: "G2", items: [{ id: "dup", text: "b" }] },
    ])
    const ids = allIds(out)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("preserves an id that is already unique", () => {
    const out = normalizeInstructions([{ id: "keepme", text: "a" }])
    expect(items(out)[0].id).toBe("keepme")
  })

  it("replaces a non-string or empty id", () => {
    const out = normalizeInstructions([{ id: "", text: "a" }, { id: 7, text: "b" }])
    expect(allIds(out).every((id) => typeof id === "string" && id.length > 0)).toBe(true)
  })
})

describe("normalizeInstructions — groups", () => {
  it("trims and truncates the group name", () => {
    const out = normalizeInstructions([{ name: `  ${"n".repeat(80)}  `, items: ["a"] }])
    expect(groups(out)[0].name).toHaveLength(60)
  })

  it("keeps an empty group — the user just created it", () => {
    const out = normalizeInstructions([{ name: "Fresh", items: [] }])
    expect(groups(out)).toHaveLength(1)
    expect(groups(out)[0].items).toEqual([])
  })

  it("flattens a nested group up into its parent instead of dropping it", () => {
    const out = normalizeInstructions([
      { name: "Outer", items: ["a", { name: "Inner", items: ["b", "c"] }] },
    ])
    expect(groups(out)).toHaveLength(1)
    expect(groups(out)[0].items.map((i) => i.text)).toEqual(["a", "b", "c"])
  })

  it("moves items out of a blank-named group rather than losing them", () => {
    const out = normalizeInstructions([{ name: "   ", items: ["a", "b"] }])
    expect(groups(out)).toHaveLength(0)
    expect(texts(out)).toEqual(["a", "b"])
  })

  it("dedupes rescued items against the root", () => {
    const out = normalizeInstructions(["a", { name: "", items: ["a", "b"] }])
    expect(texts(out)).toEqual(["a", "b"])
  })

  it("preserves root order between groups and loose instructions", () => {
    const out = normalizeInstructions(["first", { name: "G", items: ["x"] }, "last"])
    expect(out.map((n) => (isInstructionGroup(n) ? `[${n.name}]` : n.text))).toEqual([
      "first",
      "[G]",
      "last",
    ])
  })

  it("is idempotent — normalizing its own output changes nothing", () => {
    // GET normalizes on read and POST on write, so the same tree round-trips
    // through this function repeatedly; a non-idempotent rule would drift the
    // file a little on every save.
    const once = normalizeInstructions(["a", { id: "g1", name: "G", items: ["b", "c"] }])
    expect(normalizeInstructions(once)).toEqual(once)
  })
})

describe("pickTree — reading across the prompts→instructions rename", () => {
  // Losing here means the user opens the popover after upgrading and finds it
  // empty, with their file still sitting on disk untouched.
  it("prefers the current file when it has content", () => {
    expect(pickTree({ instructions: ["new"] }, { prompts: ["old"] })).toEqual(["new"])
  })

  it("falls back to the legacy file's legacy FIELD name", () => {
    expect(pickTree({}, { prompts: ["old"] })).toEqual(["old"])
  })

  it("falls back when the current file exists but is empty", () => {
    // readJsonFile cannot distinguish absent from empty, so an empty current
    // file must not shadow a populated legacy one.
    expect(pickTree({ instructions: [] }, { prompts: ["old"] })).toEqual(["old"])
  })

  it("reads a legacy file already written in the new field name", () => {
    expect(pickTree({}, { instructions: ["old"] })).toEqual(["old"])
  })

  it("returns the current value when neither has content", () => {
    expect(pickTree({ instructions: [] }, { prompts: [] })).toEqual([])
    expect(pickTree({}, {})).toBeUndefined()
  })

  it("tolerates a missing legacy file", () => {
    expect(pickTree({ instructions: ["new"] }, null)).toEqual(["new"])
    expect(pickTree({}, null)).toBeUndefined()
  })

  it("ignores non-array payloads on either side", () => {
    expect(pickTree({ instructions: "nope" }, { prompts: ["old"] })).toEqual(["old"])
    expect(pickTree({}, { prompts: "nope" })).toBeUndefined()
  })

  it("hands the legacy tree to normalizeInstructions unchanged in meaning", () => {
    // End-to-end of the two compatibility layers stacked: an old-name file
    // holding the old string[] shape must still come out as a usable tree.
    const picked = pickTree({}, { prompts: ["a", "a", "  b  "] })
    expect(normalizeInstructions(picked).map((n) => (isInstructionGroup(n) ? n.name : n.text)))
      .toEqual(["a", "b"])
  })
})
