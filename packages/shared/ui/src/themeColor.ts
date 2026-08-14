/**
 * Reading design tokens from JavaScript.
 *
 * Needed because a `<canvas>` and xterm.js do not participate in CSS at all —
 * `ctx.fillStyle` and xterm's `ITheme` take a colour string and nothing else,
 * so anything drawn that way is invisible to the theme unless something reads
 * the token and hands the value over.
 *
 * Two traps this exists to avoid, both of which shipped in this codebase:
 *
 *  1. The semantic tokens store BARE HSL TRIPLES ("240 14% 94.5%") so they can
 *     compose as `hsl(var(--x) / <alpha>)`. Passing that string straight to
 *     `ctx.strokeStyle` is not an error — it is a silent no-op, and the canvas
 *     keeps whatever colour it had. TokenStatsModal's chart grid painted
 *     default black in both themes for exactly this reason.
 *  2. Reading `getComputedStyle(el).backgroundColor` instead of a token looks
 *     more direct, but any element carrying `transition-colors` reports the
 *     INTERPOLATED value mid-transition. Read during a theme switch, that is
 *     the OUTGOING theme's colour, which then sticks. Custom properties do not
 *     transition, so reading the token is both simpler and correct.
 */

/** Bare HSL triple as stored by the semantic tokens, e.g. "240 14% 94.5%". */
const HSL_TRIPLE = /^([\d.]+)\s+([\d.]+)%\s+([\d.]+)%$/;

/**
 * Read a CSS custom property and return a colour string usable anywhere,
 * including canvas and xterm.
 *
 * Tokens holding a complete colour (the `--line-*` / `--tint-*` alpha ramps)
 * pass through untouched; tokens holding an HSL triple are converted to
 * `#rrggbb`. Hex rather than `hsl(...)` because consumers like xterm.js parse
 * colours themselves rather than deferring to the browser.
 *
 * @param el - Any element in the document; custom properties inherit, so the
 *   value resolves against whichever theme class is currently on the tree.
 * @param token - Custom property name, including the leading `--`.
 * @param fallback - Returned when the token is absent or unparseable (e.g. the
 *   component is mounted outside the app shell).
 */
export function readThemeColor(
  el: HTMLElement | null,
  token: string,
  fallback: string,
): string {
  if (!el) return fallback;
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  if (!raw) return fallback;

  const m = HSL_TRIPLE.exec(raw);
  if (!m) {
    // Already a complete colour (rgba(...) / #rrggbb) — hand it back as-is.
    return raw;
  }

  const h = Number(m[1]);
  const s = Number(m[2]) / 100;
  const l = Number(m[3]) / 100;
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const x = c * (1 - Math.abs(((h / 60) % 2) - 1));
  const base = l - c / 2;
  const [r, g, b] = [[c, x, 0], [x, c, 0], [0, c, x], [0, x, c], [x, 0, c], [c, 0, x]][
    Math.floor(h / 60) % 6
  ];
  const ch = (v: number) => Math.round((v + base) * 255).toString(16).padStart(2, '0');
  return `#${ch(r)}${ch(g)}${ch(b)}`;
}

/**
 * Same read, but returning an `hsl(... / alpha)` string so a canvas can draw a
 * translucent wash in the token's hue. Only valid for HSL-triple tokens;
 * complete-colour tokens already carry their own alpha and pass through.
 */
export function readThemeColorAlpha(
  el: HTMLElement | null,
  token: string,
  alpha: number,
  fallback: string,
): string {
  if (!el) return fallback;
  const raw = getComputedStyle(el).getPropertyValue(token).trim();
  if (!raw || !HSL_TRIPLE.test(raw)) return fallback;
  return `hsl(${raw} / ${alpha})`;
}
