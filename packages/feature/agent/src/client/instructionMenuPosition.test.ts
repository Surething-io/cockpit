/**
 * Placement tests for the quick-instruction group submenu.
 *
 * Every failure here is silent — a wrong number puts the panel off-screen or
 * behind the popover, and nothing throws. The narrow-viewport cases matter
 * because the popover already declares `max-w-[calc(100vw-1.5rem)]`, i.e. phone
 * width is a supported layout, and there the preferred side never fits.
 */
import { describe, it, expect } from "vitest"
import { computeFlyoutPosition, computeDropdownPosition, FLYOUT_WIDTH } from "./instructionMenuPosition"

/** A group row inside a 320px popover pinned to the left of the panel. */
const rowAt = (left: number, top: number, width = 320) => ({
  left,
  right: left + width,
  top,
})

const desktop = { width: 1440, height: 900 }
const phone = { width: 390, height: 844 }

describe("computeFlyoutPosition — horizontal", () => {
  it("opens to the right at full width when there is room", () => {
    const pos = computeFlyoutPosition(rowAt(12, 400), 5, desktop)
    expect(pos.width).toBe(FLYOUT_WIDTH)
    expect(pos.left).toBeGreaterThanOrEqual(12 + 320)
  })

  it("flips left at full width when the right cannot fit", () => {
    // Row pushed right so only ~100px remain on the right, but plenty on the left.
    const pos = computeFlyoutPosition(rowAt(1000, 400), 5, desktop)
    expect(pos.width).toBe(FLYOUT_WIDTH)
    expect(pos.left + pos.width).toBeLessThanOrEqual(1000)
  })

  it("narrows onto the roomier side when neither side fits", () => {
    // 390px viewport, 320px row at x=12: 58px right, 12px left. Neither fits 288.
    const pos = computeFlyoutPosition(rowAt(12, 400), 5, phone)
    expect(pos.width).toBeLessThan(FLYOUT_WIDTH)
    expect(pos.left).toBeGreaterThanOrEqual(8)
    expect(pos.left + pos.width).toBeLessThanOrEqual(phone.width - 8)
  })

  it("never places the panel off-screen, at any viewport width", () => {
    for (const width of [320, 390, 640, 768, 1024, 1440]) {
      for (const rowLeft of [0, 12, 100, width - 340, width - 60]) {
        const pos = computeFlyoutPosition(
          rowAt(Math.max(0, rowLeft), 400),
          5,
          { width, height: 900 }
        )
        expect(pos.left, `left @${width}/${rowLeft}`).toBeGreaterThanOrEqual(0)
        expect(pos.left + pos.width, `right @${width}/${rowLeft}`).toBeLessThanOrEqual(width)
      }
    }
  })
})

describe("computeFlyoutPosition — vertical", () => {
  it("top-aligns with its row when the submenu fits below", () => {
    const pos = computeFlyoutPosition(rowAt(12, 200), 3, desktop)
    expect(pos.top).toBeLessThanOrEqual(200)
    expect(pos.top).toBeGreaterThan(150)
  })

  it("shifts up so a long submenu stays on screen", () => {
    const pos = computeFlyoutPosition(rowAt(12, 850), 20, desktop)
    expect(pos.top).toBeGreaterThanOrEqual(8)
    expect(pos.top + Math.min(pos.maxHeight, 20 * 30 + 40)).toBeLessThanOrEqual(desktop.height)
  })

  it("bottom-aligns a capped-height submenu instead of overflowing", () => {
    // 500 items would be 15000px tall, but maxHeight caps it at 540, so the
    // panel is placed to end exactly at the bottom margin — not pinned to 8.
    const pos = computeFlyoutPosition(rowAt(12, 880), 500, desktop)
    expect(pos.top).toBeGreaterThanOrEqual(8)
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(desktop.height - 8)
  })

  it("caps maxHeight at 60% of the viewport", () => {
    expect(computeFlyoutPosition(rowAt(12, 100), 500, desktop).maxHeight).toBe(540)
  })

  it("keeps a usable maxHeight on a very short viewport", () => {
    // 60% of 100px is 60px — two rows. The floor keeps three.
    expect(
      computeFlyoutPosition(rowAt(12, 40), 5, { width: 1440, height: 100 }).maxHeight
    ).toBeGreaterThanOrEqual(90)
  })
})

describe("computeDropdownPosition", () => {
  const trigger = (left: number, top: number, width = 280, height = 24) => ({
    left,
    top,
    bottom: top + height,
    width,
  })

  it("opens downwards and tracks the trigger's width and left edge", () => {
    const pos = computeDropdownPosition(trigger(40, 300), 3, desktop)
    expect(pos.left).toBe(40)
    expect(pos.width).toBe(280)
    expect(pos.top).toBeGreaterThanOrEqual(324)
  })

  it("flips above when the trigger sits near the bottom", () => {
    // The popover is anchored to the bottom of the screen, so this is the
    // COMMON case, not an edge case.
    const pos = computeDropdownPosition(trigger(40, 830), 4, desktop)
    expect(pos.top + pos.maxHeight).toBeLessThanOrEqual(830)
  })

  it("clamps width and left on a narrow viewport", () => {
    const pos = computeDropdownPosition(trigger(12, 300, 380), 3, phone)
    expect(pos.left).toBeGreaterThanOrEqual(8)
    expect(pos.left + pos.width).toBeLessThanOrEqual(phone.width - 8)
  })

  it("stays on screen for any trigger position", () => {
    for (const height of [400, 700, 900]) {
      for (const top of [0, 50, height / 2, height - 100, height - 30]) {
        const pos = computeDropdownPosition(trigger(40, top), 6, { width: 1440, height })
        expect(pos.top, `top @${height}/${top}`).toBeGreaterThanOrEqual(0)
        expect(pos.top + pos.maxHeight, `bottom @${height}/${top}`).toBeLessThanOrEqual(height)
      }
    }
  })

  it("shrinks to the room available rather than overflowing", () => {
    const pos = computeDropdownPosition(trigger(40, 700), 40, desktop)
    expect(pos.maxHeight).toBeLessThanOrEqual(desktop.height - 700 - 24)
  })
})
