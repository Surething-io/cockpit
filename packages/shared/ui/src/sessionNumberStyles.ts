/**
 * Status colours for session number badges.
 *
 * The status used to be a separate dot pinned to the number's top-right corner
 * (an orange `animate-pulse` one for "generating", a red one for "unread").
 * Two 8px glyphs stacked on a 16px badge is a lot of flicker for very little
 * information, so the badge itself carries the state:
 *
 *   generating -> warm orange wash, pulsing
 *   unread     -> red wash, static
 *   seen       -> brand wash (active) / neutral wash (inactive)
 *
 * Three rules keep this from reading as a traffic light, which is exactly how
 * the first cut looked:
 *
 * 1. `-11`, not `-9`. The `-9` steps are the same fully saturated value in both
 *    themes; the `-11` steps swing with the theme (deep amber-brown in light,
 *    soft peach in dark), so a 16px badge stays legible on either surface
 *    instead of glowing on one of them.
 * 2. A wash, no ring — for every variant, including the idle ones. On a 16px
 *    circle a 1px border is a big share of the ink and is where the cheap look
 *    came from; the tinted fill alone carries the state. `border-transparent`
 *    keeps the box geometry the callers already lay out, so nothing shifts by a
 *    pixel when a status flips.
 * 3. Neutral digits on the status variants. The number is information, not
 *    decoration; colouring it only made it harder to read at 9px. The idle
 *    variants keep their brand/muted digit — that pair is a selection cue
 *    (which tab am I on), not a status.
 *
 * The idle wash is `muted-foreground`, not `muted`: `muted` is slate-3, within
 * a hair of the surface it sits on, so a 15% wash of it is invisible in dark
 * mode — the border was the only thing making that badge a badge.
 *
 * Shared by the chat tab bar and the per-project session badges in the sidebar
 * so the two never drift apart.
 */
export type SessionNumberStatus = 'loading' | 'unread' | 'normal';

export function sessionNumberClass(status: SessionNumberStatus, isActive: boolean): string {
  if (status === 'loading') return 'border-transparent bg-orange-11/25 text-foreground animate-pulse';
  if (status === 'unread') return 'border-transparent bg-red-11/25 text-foreground';
  return isActive
    ? 'border-transparent bg-brand/15 text-brand'
    : 'border-transparent bg-muted-foreground/15 text-muted-foreground';
}
