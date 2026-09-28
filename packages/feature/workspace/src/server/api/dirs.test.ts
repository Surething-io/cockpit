import path from "path"
import { describe, expect, it } from "vitest"
import { isHiddenName, parentOf, resolveInput, toSegments } from "./dirs"

const { posix, win32 } = path

describe("resolveInput", () => {
  it("maps empty and ~ to home", () => {
    expect(resolveInput("", "/Users/ka", posix)).toBe("/Users/ka")
    expect(resolveInput(" ~ ", "/Users/ka", posix)).toBe("/Users/ka")
    expect(resolveInput("~/Work/", "/Users/ka", posix)).toBe("/Users/ka/Work")
  })

  it("keeps absolute paths and resolves relative ones against home", () => {
    expect(resolveInput("/tmp/../etc", "/Users/ka", posix)).toBe("/etc")
    expect(resolveInput("Work", "/Users/ka", posix)).toBe("/Users/ka/Work")
  })

  it("handles Windows drives, either slash and ~\\", () => {
    expect(resolveInput("D:/code/app", "C:\\Users\\ka", win32)).toBe("D:\\code\\app")
    expect(resolveInput("~\\Work", "C:\\Users\\ka", win32)).toBe("C:\\Users\\ka\\Work")
    expect(resolveInput("\\\\srv\\share\\x", "C:\\Users\\ka", win32)).toBe("\\\\srv\\share\\x")
  })
})

describe("toSegments", () => {
  it("splits POSIX paths with / as the root crumb", () => {
    expect(toSegments("/", posix)).toEqual([{ name: "/", path: "/" }])
    expect(toSegments("/Users/ka", posix)).toEqual([
      { name: "/", path: "/" },
      { name: "Users", path: "/Users" },
      { name: "ka", path: "/Users/ka" },
    ])
  })

  it("uses the drive or UNC share as the Windows root crumb", () => {
    expect(toSegments("C:\\Users\\ka", win32)).toEqual([
      { name: "C:\\", path: "C:\\" },
      { name: "Users", path: "C:\\Users" },
      { name: "ka", path: "C:\\Users\\ka" },
    ])
    expect(toSegments("\\\\srv\\share\\proj", win32)).toEqual([
      { name: "\\\\srv\\share\\", path: "\\\\srv\\share\\" },
      { name: "proj", path: "\\\\srv\\share\\proj" },
    ])
  })
})

describe("parentOf", () => {
  it("returns null only at a root", () => {
    expect(parentOf("/", posix)).toBeNull()
    expect(parentOf("/Users", posix)).toBe("/")
    expect(parentOf("C:\\", win32)).toBeNull()
    expect(parentOf("C:\\Users", win32)).toBe("C:\\")
    expect(parentOf("\\\\srv\\share\\", win32)).toBeNull()
  })
})

describe("isHiddenName", () => {
  it("hides dot dirs everywhere and system dirs on Windows only", () => {
    expect(isHiddenName(".git", "darwin")).toBe(true)
    expect(isHiddenName("$Recycle.Bin", "darwin")).toBe(false)
    expect(isHiddenName("$Recycle.Bin", "win32")).toBe(true)
    expect(isHiddenName("System Volume Information", "win32")).toBe(true)
    expect(isHiddenName("Work", "win32")).toBe(false)
  })
})
