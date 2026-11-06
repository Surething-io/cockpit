import { describe, it, expect } from "vitest"
import { isHomeRelativePath, expandHomePath } from "./homePath"
import {
  toLocalAppUrl,
  toFileViewerUrl,
  fromLocalAppUrl,
  isRootedPath,
  toLocalPreviewUrl,
  isFileViewerPath,
} from "./htmlBashSdk"

const HOME = "/Users/me"
const PROJECT = "/Users/me/Work/proj"

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
    expect(isHomeRelativePath("/Users/me/~/x")).toBe(false)
  })
})

describe("expandHomePath", () => {
  it("expands the leading ~ only", () => {
    expect(expandHomePath("~", HOME)).toBe("/Users/me")
    expect(expandHomePath("~/Desktop/x.html", HOME)).toBe(
      "/Users/me/Desktop/x.html"
    )
    expect(expandHomePath("~alice/x", HOME)).toBe("~alice/x")
    expect(expandHomePath("./x.html", HOME)).toBe("./x.html")
    expect(expandHomePath("/abs/x", HOME)).toBe("/abs/x")
  })

  it("preserves a trailing separator (path autocomplete depends on it)", () => {
    expect(expandHomePath("~/", HOME)).toBe("/Users/me/")
  })

  it("does not double a separator when home has a trailing slash", () => {
    expect(expandHomePath("~/x", "/Users/me/")).toBe("/Users/me/x")
  })

  it("returns the input untouched when no home is known", () => {
    expect(expandHomePath("~/x", "")).toBe("~/x")
  })
})

describe("~ survives the /apps/local round trip", () => {
  it("is not joined against the project root (the <cwd>/~/... 404)", () => {
    expect(isRootedPath("~/Desktop/x.html")).toBe(true)
    expect(toLocalAppUrl("~/Desktop/proj-report.html", PROJECT)).toBe(
      "/apps/local/~/Desktop/proj-report.html"
    )
  })

  it("decodes back to the tilde form, for the server to expand", () => {
    const url = toLocalAppUrl("~/Desktop/a b.html", PROJECT)
    const raw = fromLocalAppUrl(new URL(url, "http://x").pathname)
    expect(raw).toBe("~/Desktop/a b.html")
    expect(expandHomePath(raw!, HOME)).toBe("/Users/me/Desktop/a b.html")
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
      "/apps/local/Users/me/Work/proj/report.html"
    )
  })
})

describe("console-typed relative paths", () => {
  it("collapses `.` and `..` so the traversal guard does not reject them", () => {
    expect(toLocalAppUrl("./report.html", PROJECT)).toBe(
      "/apps/local/Users/me/Work/proj/report.html"
    )
    expect(toLocalAppUrl("../sibling/report.html", PROJECT)).toBe(
      "/apps/local/Users/me/Work/sibling/report.html"
    )
    expect(toFileViewerUrl("./notes.md", PROJECT)).toBe(
      "/apps/builtin/file-viewer/index.html?file=" +
        encodeURIComponent("/Users/me/Work/proj/notes.md")
    )
  })

  it("round-trips a `..` path that used to 403", () => {
    const url = toLocalAppUrl("../sibling/report.html", PROJECT)
    expect(fromLocalAppUrl(url)).toBe("/Users/me/Work/sibling/report.html")
  })

  it("keeps `.` / `..` collapsing from eating the tilde", () => {
    expect(toLocalAppUrl("~/Desktop/../Desktop/x.html", PROJECT)).toBe(
      "/apps/local/~/Desktop/x.html"
    )
  })
})

describe("paths copied from preview titles", () => {
  it("keeps an absolute TXT path absolute despite the title's leading LRM", () => {
    const file = "/Users/me/.cockpit/artifacts/review-instruction.txt"
    const url = toFileViewerUrl("\u200e" + file, PROJECT)
    expect(new URL(url, "http://localhost").searchParams.get("file")).toBe(file)
  })

  it("handles whitespace around a copied path for either preview runtime", () => {
    const file = "/Users/me/report.html"
    expect(fromLocalAppUrl(toLocalAppUrl(" \u200e" + file + "\n", PROJECT))).toBe(file)
    const url = toFileViewerUrl(" \u200e~/notes.txt\n", PROJECT)
    expect(new URL(url, "http://localhost").searchParams.get("file")).toBe("~/notes.txt")
  })

  it("preserves LRM inside a filename", () => {
    const file = "/Users/me/report\u200e.txt"
    const url = toFileViewerUrl(file, PROJECT)
    expect(new URL(url, "http://localhost").searchParams.get("file")).toBe(file)
  })
})

describe("explicit local browser previews", () => {
  it.each(["/tmp/review.APElEH", "/tmp/README", "/tmp/code.ts"])("routes %s through the document viewer", (file) => {
    const url = new URL(toLocalPreviewUrl(file, PROJECT), "http://localhost")
    expect(url.pathname).toBe("/apps/builtin/file-viewer/index.html")
    expect(url.searchParams.get("file")).toBe(file)
  })

  it("preserves explicit HTML pages and Console command detection", () => {
    expect(toLocalPreviewUrl("app.html", PROJECT)).toBe(toLocalAppUrl("app.html", PROJECT))
    expect(isFileViewerPath("git status")).toBe(false)
    expect(isFileViewerPath("npm run dev")).toBe(false)
    expect(isFileViewerPath("/usr/bin/env")).toBe(false)
    expect(isFileViewerPath("/tmp/review.APElEH")).toBe(false)
    expect(isFileViewerPath("notes.txt")).toBe(true)
  })
})
