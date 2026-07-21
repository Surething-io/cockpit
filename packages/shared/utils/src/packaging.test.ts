/**
 * Packaging guard.
 *
 * `package.json#files` is a whitelist, and this repo colocates tests with the
 * sources they cover. The moment a whitelisted directory gains a test file it
 * would ship to npm users unless the negation patterns keep it out — which is
 * exactly what happened when `apps/` was added.
 *
 * Asserted against the manifest rather than by running `npm pack` so the check
 * stays fast and offline.
 */
import { describe, it, expect } from "vitest"
import { readFileSync, readdirSync, statSync } from "fs"
import { join } from "path"

const repoRoot = join(__dirname, "..", "..", "..", "..")
const pkg = JSON.parse(
  readFileSync(join(repoRoot, "package.json"), "utf-8")
) as { files: string[] }

const TEST_FILE_RE = /\.(test|spec)\./

/** Recursively list files under a whitelisted entry, ignoring node_modules. */
function walk(rel: string, out: string[] = []): string[] {
  const abs = join(repoRoot, rel)
  let st
  try {
    st = statSync(abs)
  } catch {
    return out // build output that may not exist in a clean checkout
  }
  if (!st.isDirectory()) {
    out.push(rel)
    return out
  }
  if (rel.includes("node_modules")) return out
  for (const entry of readdirSync(abs)) walk(join(rel, entry), out)
  return out
}

describe("package.json#files", () => {
  it("excludes colocated tests from the published package", () => {
    expect(pkg.files).toContain("!**/*.test.*")
    expect(pkg.files).toContain("!**/*.spec.*")
  })

  it("keeps every colocated test in a whitelisted dir out of the package", () => {
    // Only the hand-authored source dirs — build output (.next-prod, dist) is
    // generated and would make this slow and noisy.
    const sourceDirs = pkg.files.filter(
      (f) => !f.startsWith("!") && !f.startsWith(".next") && f !== "dist"
    )
    const negations = pkg.files
      .filter((f) => f.startsWith("!"))
      .map((f) => f.slice(1))

    const covers = (pattern: string, file: string) => {
      // Only the `**/*.x.*` shape used here needs supporting.
      const suffix = pattern.replace(/^\*\*\/\*/, "")
      return file.includes(suffix.replace(/\*$/, ""))
    }

    const uncovered = sourceDirs
      .flatMap((d) => walk(d))
      .filter((f) => TEST_FILE_RE.test(f))
      .filter((f) => !negations.some((p) => covers(p, f)))

    // Asserts coverage, not an exact inventory: adding a test next to shipped
    // source stays fine, it just must not slip into the tarball.
    expect(uncovered).toEqual([])
  })
})
