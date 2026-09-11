/**
 * Status colours for session number badges.
 *
 * The status used to be a separate dot pinned to the number's top-right corner
 * (an orange `animate-pulse` one for "generating", a red one for "unread").
 * Two 8px glyphs stacked on a 16px badge is a lot of flicker for very little
 * information, so the badge itself carries the state:
 *
 *   generating -> subtle orange wash with a rotating orange outer ring
 *   unread     -> red wash, static
 *   seen       -> brand wash (active) / neutral wash (inactive)
 *
 * Three rules keep this from reading as a traffic light, which is exactly how
 * the first cut looked:
 *
 * 1. Orange distinguishes active work from both normal brand selection and the
 *    red completed result that still needs attention.
 * 2. A wash with no static ring for idle/unread. Running alone adds a thin
 *    animated outer ring, whose transparent top segment makes progress legible
 *    without flashing the number itself. `border-transparent` keeps the chip's
 *    box geometry stable while the ring sits outside it.
 * 3. Neutral digits on the status variants. The number is information, not
 *    decoration; colouring it only made it harder to read at 9px. The idle
 *    variants keep their brand/muted digit — that pair is a selection cue
 *    (which tab am I on), not a status.
 *
 * The idle wash is `muted-foreground`, not `muted`: `muted` is slate-3, within
 * a hair of the surface it sits on, so a 15% wash of it is invisible in dark
 * mode — the border was the only thing making that badge a badge.
 *
 * Running and unread are told apart by colour, motion and weight. Unread is a
 * near-solid red chip against running's light orange wash and moving ring: the
 * state that wants you to go look is the heavy one, and that difference also
 * survives when motion is reduced.
 *
 * The heavy chip fills from `red-9`, not `red-11`. In Radix terms 9 is the
 * solid-fill step and 11 the text step: `red-11` is bright in dark mode, so at
 * 55% it lands near the foreground's own lightness and the numeral stops
 * reading. `red-9` holds one value across both themes.
 *
 * Shared by the chat tab bar and the per-project session badges in the sidebar
 * so the two never drift apart.
 */
export type SessionNumberStatus = 'loading' | 'unread' | 'normal';

export function sessionNumberClass(status: SessionNumberStatus, isActive: boolean): string {
  if (status === 'loading') {
    return 'relative session-number-running border-transparent bg-orange-11/15 text-orange-11';
  }
  if (status === 'unread') return 'border-transparent bg-red-9/55 text-foreground';
  return isActive
    ? 'border-transparent bg-brand/15 text-brand'
    : 'border-transparent bg-muted-foreground/15 text-muted-foreground';
}
