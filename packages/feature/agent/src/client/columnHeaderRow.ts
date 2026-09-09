/**
 * The bar at the top of a column in the agent panel.
 *
 * Two of them can sit side by side — a chat's engine options row on one side,
 * the diff viewer's title bar on the other — and any difference in height there
 * reads as the whole panel being misaligned.
 *
 * The height is DECLARED rather than left to padding, and that is the point.
 * Padding makes a bar as tall as whatever it happens to contain, and what these
 * two contain is not comparable: text-xs controls and a model chip on one side,
 * a text-sm title and icon buttons on the other. Worse, the chat side is not
 * even one height — measured against the shipped CSS (`--spacing` .25rem with
 * html at 14px, so a Tailwind unit is 3.5px), `py-1.5` gave 30px on the
 * API-key row and 31.5px on the claude/codex and ollama rows, because their
 * tallest child differs. Matching that by adjusting padding is chasing a number
 * that moves with the engine. `h-9` (31.5px) plus `items-center` makes the two
 * equal by construction, for every engine, permanently.
 *
 * 31.5px is the larger of the two former heights, so no row gets shorter and
 * nothing can clip: the tallest content measured in any of them is a 21px
 * `text-xs px-2 py-1` chip.
 *
 * Horizontal padding is deliberately NOT here — it is the one thing the two
 * bars must NOT share. The chat side reserves `pr-8` for the close-this-column
 * ✕ that PaneShell floats over it; the diff column has no such ✕, and copying
 * the reservation would inset its own ✕ from an edge nothing is covering.
 */
export const COLUMN_HEADER_ROW =
  'flex items-center gap-2 h-9 flex-shrink-0 border-b border-border';
