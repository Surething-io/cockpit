/**
 * The class strings shared by the app's full-viewport "board" dialogs — the
 * ones that list things happening elsewhere (recent sessions, project sessions,
 * session browser, skills, HTML apps, scheduled tasks).
 *
 * They were six copies of the same literal, which had already drifted once
 * (one of them was missing `overflow-hidden`), and every width tweak meant
 * finding all six. One constant, one edit.
 *
 * Width rule: `(window - sidebar x 2) * 90%` — the board leaves a gap as wide
 * as the project list on both sides, so it never crowds the sidebar it opens
 * over and stays symmetric. `14rem` is ProjectSidebar's expanded `w-56` (224px)
 * — keep them in sync; collapsed (`w-12`) simply leaves a wider gap.
 *
 * No breakpoint and no absolute cap: the formula already scales with the
 * display, which is what the earlier `max-w-7xl` (too narrow on a wide screen)
 * and `90vw` (a 4600px dialog on a 5K) each got wrong in one direction.
 *
 * `w-full` + `mx-4` still floor it, so a very narrow window degrades to
 * "viewport minus a 1rem gutter" instead of a negative width.
 *
 * The two exports differ ONLY in how much of `100vw` is already spoken for.
 * Both are written out in full rather than built from a helper: Tailwind scans
 * source text for candidates and never sees an interpolated class name.
 */

/**
 * Boards rendered in the host window (launched from the sidebar):
 * SessionBrowser, SkillsModal, HtmlAppsModal, ScheduledTasksPanel,
 * RecentSessionsModal. Here `100vw` is the whole window, so both gutters have
 * to come off.
 */
export const MODAL_SHELL_CLASS =
  'relative w-full max-w-[calc((100vw_-_28rem)*0.9)] h-[90vh] mx-4 bg-card rounded-lg shadow-lv3 flex flex-col overflow-hidden';

/**
 * Same rule, for a board rendered INSIDE the per-project iframe —
 * ProjectSessionsModal, mounted from TabManager / Chat.
 *
 * There `100vw` is the iframe, which already excludes the sidebar. Subtracting
 * two sidebar widths charged for it twice and left the dialog 202px narrower
 * than the identical board in the host window; subtracting one yields the same
 * absolute width, i.e. the same gap measured from the window edge.
 */
export const MODAL_SHELL_CLASS_IN_PROJECT =
  'relative w-full max-w-[calc((100vw_-_14rem)*0.9)] h-[90vh] mx-4 bg-card rounded-lg shadow-lv3 flex flex-col overflow-hidden';

/**
 * Card grid for those boards. `auto-fill` + a 320px minimum means the column
 * count follows the available width instead of stopping at a breakpoint — at
 * 5000px the old `grid-cols-1 md:2 lg:3` gave three 1500px-wide cards.
 *
 * 320px is the width these cards already render at on a `md` screen, so nothing
 * inside them (line-clamps, icon rows) has to change.
 */
export const MODAL_CARD_GRID_CLASS =
  'grid grid-cols-[repeat(auto-fill,minmax(320px,1fr))] gap-3';
