import { describe, it, expect } from "vitest"
import { isHomeRelativePath, expandHomePath } from "./homePath"
import {
  toLocalAppUrl,
  toFileViewerUrl,
  fromLocalAppUrl,
  isRootedPath,
} from "./htmlBashSdk"

const HOME = "/Users/ka"
const PROJECT = "/Users/ka/Work/anycross"

describe("isHomeRelativePath", () => {
  it("matches bare ~ and ~-rooted paths on both separators", () => {
    expect(isHomeRelativePath("~")).toBe(true)
    expect(isHomeRelativePath("~/Desktop/x.html")).toBe(true)
    expect(isHomeRelativePath("~\\Desktop\\x.html")).toBe(true)
    expect(isHomeRelativePath("  ~/x  ")).toBe(true)
  })

  it("does not match ~user (POSIX-only, needs /etc/passwd) or a mid-path ~", () => {
    expect(isHomeRelativePath("~alice/x")).toBe(false)
    expect(isHomeRelativePath("~backup.html")).toBe(false)
    expect(isHomeRelativePath("./~/x")).toBe(false)
    expect(isHomeRelativePath("/Users/ka/~/x")).toBe(false)
  })
})

describe("expandHomePath", () => {
  it("expands the leading ~ only", () => {
    expect(expandHomePath("~", HOME)).toBe("/Users/ka")
    expect(expandHomePath("~/Desktop/x.html", HOME)).toBe(
      "/Users/ka/Desktop/x.html"
    )
    expect(expandHomePath("~alice/x", HOME)).toBe("~alice/x")
    expect(expandHomePath("./x.html", HOME)).toBe("./x.html")
    expect(expandHomePath("/abs/x", HOME)).toBe("/abs/x")
  })

  it("preserves a trailing separator (path autocomplete depends on it)", () => {
    expect(expandHomePath("~/", HOME)).toBe("/Users/ka/")
  })

  it("does not double a separator when home has a trailing slash", () => {
    expect(expandHomePath("~/x", "/Users/ka/")).toBe("/Users/ka/x")
  })

  it("returns the input untouched when no home is known", () => {
    expect(expandHomePath("~/x", "")).toBe("~/x")
  })
})

describe("~ survives the /apps/local round trip", () => {
  it("is not joined against the project root (the <cwd>/~/... 404)", () => {
    expect(isRootedPath("~/Desktop/x.html")).toBe(true)
    expect(toLocalAppUrl("~/Desktop/anycross-report.html", PROJECT)).toBe(
      "/apps/local/~/Desktop/anycross-report.html"
    )
  })

  it("decodes back to the tilde form, for the server to expand", () => {
    const url = toLocalAppUrl("~/Desktop/a b.html", PROJECT)
    const raw = fromLocalAppUrl(new URL(url, "http://x").pathname)
    expect(raw).toBe("~/Desktop/a b.html")
    expect(expandHomePath(raw!, HOME)).toBe("/Users/ka/Desktop/a b.html")
  })

  it("still rejects traversal through a ~-rooted path", () => {
    expect(fromLocalAppUrl("/apps/local/~/..%2Fetc/passwd")).toBe(null)
  })

  it("keeps the file-viewer query param in tilde form", () => {
    expect(toFileViewerUrl("~/Desktop/report.md", PROJECT)).toBe(
      "/apps/builtin/file-viewer/index.html?file=" +
        encodeURIComponent("~/Desktop/report.md")
    )
  })

  it("leaves plain relative paths resolving against the base cwd", () => {
    expect(toLocalAppUrl("report.html", PROJECT)).toBe(
      "/apps/local/Users/ka/Work/anycross/report.html"
    )
  })
})

describe("console-typed relative paths", () => {
  it("collapses `.` and `..` so the traversal guard does not reject them", () => {
    expect(toLocalAppUrl("./report.html", PROJECT)).toBe(
      "/apps/local/Users/ka/Work/anycross/report.html"
    )
    expect(toLocalAppUrl("../sibling/report.html", PROJECT)).toBe(
      "/apps/local/Users/ka/Work/sibling/report.html"
    )
    expect(toFileViewerUrl("./notes.md", PROJECT)).toBe(
      "/apps/builtin/file-viewer/index.html?file=" +
        encodeURIComponent("/Users/ka/Work/anycross/notes.md")
    )
  })

  it("round-trips a `..` path that used to 403", () => {
    const url = toLocalAppUrl("../sibling/report.html", PROJECT)
    expect(fromLocalAppUrl(url)).toBe("/Users/ka/Work/sibling/report.html")
  })

  it("keeps `.` / `..` collapsing from eating the tilde", () => {
    expect(toLocalAppUrl("~/Desktop/../Desktop/x.html", PROJECT)).toBe(
      "/apps/local/~/Desktop/x.html"
    )
  })
})
