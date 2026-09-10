/**
 * Placement math for the quick-instruction popover's floating layers: the group
 * submenu (opens sideways) and the group picker dropdown (opens downwards).
 *
 * Split out of QuickInstructionsPopover.tsx purely so it can be unit-tested without
 * pulling React, i18next and the Effect runtime into the test — the flips and
 * the narrow-viewport fallbacks are the only real logic in either layer, and
 * both fail invisibly (the panel lands off-screen, where nothing throws).
 *
 * BOTH layers are portaled to <body> and positioned `fixed`, for two reasons
 * that are both hard blockers rather than preferences:
 *
 *  1. The popover is `max-h-[70vh] overflow-y-auto`. A submenu rendered inside
 *     it would be clipped horizontally as well — `overflow-y: auto` forces the
 *     computed `overflow-x` to `auto`, so a child cannot visually escape.
 *  2. SwipeableViewContainer's viewport is `overflow-hidden` at panel width. A
 *     `fixed` node that is not its descendant ignores that; an absolute one
 *     inside it does not.
 *
 * Deliberately NOT the shared <Portal>: under PanelPortalProvider that mounts
 * into a `translateZ(0)` wrapper, which makes `fixed` resolve against the PANEL
 * box while getBoundingClientRect keeps reporting VIEWPORT coordinates — the
 * two would silently disagree by the panel's translateX.
 */

/** Matches Tailwind `w-72`. */
export const FLYOUT_WIDTH = 288;
const FLYOUT_GAP = 4;
const VIEWPORT_MARGIN = 8;
/** Below this a submenu is unreadable, so it overlaps its parent instead. */
const MIN_FLYOUT_WIDTH = 180;
/** Approximate row height, used to guess the height for vertical placement. */
const ROW_HEIGHT = 30;
/** Header + padding above and below the rows. */
const FLYOUT_CHROME = 40;

export interface FlyoutPosition {
  left: number;
  top: number;
  width: number;
  maxHeight: number;
}

export interface FlyoutAnchor {
  top: number;
  left: number;
  right: number;
}

export interface FlyoutViewport {
  width: number;
  height: number;
}

/**
 * Position the flyout from its group row's viewport rect.
 *
 * Horizontally: prefer the right, flip to the left when the right cannot fit a
 * full-width panel, and when NEITHER side fits (phone-width panels have no
 * 288px to spare either way) narrow onto the roomier side rather than flipping
 * to a spot that is still off-screen.
 *
 * Vertically: top-aligned with the row, pushed up only as far as needed. The
 * height is ESTIMATED from the item count instead of measured — measuring means
 * render → read layout → reposition, which paints the panel in the wrong place
 * for one frame. The estimate only decides "hangs down" vs "shifted up", and
 * `maxHeight` plus internal scrolling absorbs the error.
 */
export const computeFlyoutPosition = (
  anchor: FlyoutAnchor,
  itemCount: number,
  viewport: FlyoutViewport
): FlyoutPosition => {
  const roomRight = viewport.width - anchor.right - FLYOUT_GAP - VIEWPORT_MARGIN;
  const roomLeft = anchor.left - FLYOUT_GAP - VIEWPORT_MARGIN;

  let width = FLYOUT_WIDTH;
  let left: number;
  if (roomRight >= FLYOUT_WIDTH) {
    left = anchor.right + FLYOUT_GAP;
  } else if (roomLeft >= FLYOUT_WIDTH) {
    left = anchor.left - FLYOUT_GAP - FLYOUT_WIDTH;
  } else if (roomRight >= roomLeft) {
    width = Math.max(MIN_FLYOUT_WIDTH, roomRight);
    left = anchor.right + FLYOUT_GAP;
  } else {
    width = Math.max(MIN_FLYOUT_WIDTH, roomLeft);
    left = anchor.left - FLYOUT_GAP - width;
  }

  // MIN_FLYOUT_WIDTH can still overshoot on a very narrow viewport, and a
  // flipped-left panel can start at a negative x. Clamp last so the panel is
  // always fully on screen, even if that means covering the row it came from.
  const maxLeft = Math.max(VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN);
  left = Math.min(Math.max(VIEWPORT_MARGIN, left), maxLeft);

  const maxHeight = Math.max(ROW_HEIGHT * 3, viewport.height * 0.6);
  const estimatedHeight = Math.min(maxHeight, itemCount * ROW_HEIGHT + FLYOUT_CHROME);
  let top = anchor.top - FLYOUT_GAP;
  if (top + estimatedHeight > viewport.height - VIEWPORT_MARGIN) {
    top = viewport.height - VIEWPORT_MARGIN - estimatedHeight;
  }
  top = Math.max(VIEWPORT_MARGIN, top);

  return { left, top, width, maxHeight };
};

// ── Group picker dropdown ──────────────────────────────────────────────────

const DROPDOWN_GAP = 2;
/** Room below this and the dropdown flips above its trigger instead. */
const MIN_DROPDOWN_HEIGHT = 96;
const DROPDOWN_ROW_HEIGHT = 28;
const DROPDOWN_PADDING = 8;

export interface DropdownAnchor {
  top: number;
  left: number;
  bottom: number;
  width: number;
}

/**
 * Position the group picker under (or over) its trigger.
 *
 * Width tracks the trigger so the dropdown reads as part of the field rather
 * than as a detached menu, clamped to the viewport for the narrow-panel case.
 *
 * Vertical side is chosen by available room, not by a fixed preference: the
 * editor row can sit anywhere from the top of a long popover to just above the
 * chat input, and the popover itself is anchored to the BOTTOM of the screen,
 * so "always downwards" would open off-screen for the common case.
 */
export const computeDropdownPosition = (
  anchor: DropdownAnchor,
  optionCount: number,
  viewport: FlyoutViewport
): FlyoutPosition => {
  const width = Math.min(anchor.width, viewport.width - VIEWPORT_MARGIN * 2);
  const left = Math.min(
    Math.max(VIEWPORT_MARGIN, anchor.left),
    Math.max(VIEWPORT_MARGIN, viewport.width - width - VIEWPORT_MARGIN)
  );

  const roomBelow = viewport.height - anchor.bottom - DROPDOWN_GAP - VIEWPORT_MARGIN;
  const roomAbove = anchor.top - DROPDOWN_GAP - VIEWPORT_MARGIN;
  const wanted = optionCount * DROPDOWN_ROW_HEIGHT + DROPDOWN_PADDING;

  // Below unless it is both too tight AND worse than above — flipping for a
  // marginal gain would make the picker jump sides as the list grows by one.
  const openDown = roomBelow >= Math.min(wanted, MIN_DROPDOWN_HEIGHT) || roomBelow >= roomAbove;
  if (openDown) {
    return {
      left,
      top: anchor.bottom + DROPDOWN_GAP,
      width,
      maxHeight: Math.max(DROPDOWN_ROW_HEIGHT, Math.min(wanted, roomBelow)),
    };
  }
  const maxHeight = Math.max(DROPDOWN_ROW_HEIGHT, Math.min(wanted, roomAbove));
  return { left, top: anchor.top - DROPDOWN_GAP - maxHeight, width, maxHeight };
};
