/**
 * Scroll ownership for the chat transcript, as a pure reducer.
 *
 * Why a reducer and not five effects
 * ----------------------------------
 * The bug this replaces was five independent writers of `scrollTop` — the
 * follow-the-tail effect, the isLoading effect, the tab-activate effect, the
 * initial-load effect and a ResizeObserver — each with its own idea of where
 * "the bottom" is, and a reserved-blank spacer whose lifetime was owned by
 * nobody. Three symptoms came out of that one hole:
 *
 *   1. a completed turn left half a screen of blank that nothing reclaimed;
 *      (the blank now decays as the reply grows into it, and whatever is left
 *      is handed back when the run finishes — see 'settle');
 *   2. a background tab measured itself at zero (display:none) and froze that
 *      blank in place;
 *   3. scrolling during a stream was undone within 50ms, pinning the reader to
 *      the top of the turn.
 *
 * All three were one confusion: `scrollHeight` INCLUDES the spacer, so
 * "scroll to the end of the scroller" and "scroll to the end of the content"
 * differ by exactly one spacer, and the pin formula made those two positions
 * numerically identical. Following the wrong one glued the viewport to the
 * blank and re-applied it on every streamed token.
 *
 * The one rule
 * ------------
 * The spacer is DERIVED, never owned:
 *
 *     spacer = max(0, targetScrollTop + clientHeight - contentHeight)
 *
 * i.e. exactly enough blank to make the position we want to be at reachable,
 * and never one pixel more. Two consequences fall out for free:
 *
 *   - Shrinking it can never move the content. The identity above guarantees
 *     `contentHeight + spacer - clientHeight >= scrollTop`, so the browser
 *     never has to clamp. A pin therefore does not have to be "released" with
 *     a jump — the blank simply evaporates as the reply grows into it, or as
 *     the reader scrolls up out of it.
 *   - A leak is not expressible. There is no state in which a spacer survives
 *     the position that justified it, because every event recomputes it from
 *     the position.
 *
 * Dead geometry is a no-op, not a measurement. A `display:none` pane reports
 * every rect as 0, and the old code fed that back into the formula, which
 * returned the current spacer unchanged — a fixed point that could never
 * converge. `reduceScroll` returns `null` there instead: a hidden tab changes
 * nothing at all and is re-derived from real numbers when it comes back.
 */

export type ScrollMode = 'follow' | 'pinned' | 'reading' | 'free';

/**
 * follow → glue the viewport to the end of the CONTENT (the default)
 * pinned → the turn the user just sent sits at the top of the viewport and the
 *          reply grows downward into reserved blank space below it
 * reading → the reader returned from a background tab at the start of its
 *           running turn; keep that start fixed until a real gesture takes over
 * free   → the reader took over by hand; never move the viewport for them
 *
 * follow ──send──▶ pinned ──reply outgrows the reserved blank──▶ follow
 *   ▲                │                                             │
 *   │           gesture (wheel/touch/key)                    scroll up
 *   │                ▼                                             ▼
 *   └──── scrolled back to the content end ──────────────────────  free
 *
 * background return ──▶ reading ──gesture──▶ free
 */
export interface ScrollOwner {
  mode: ScrollMode;
  /**
   * The offset a pin is holding, and the only thing the spacer is derived from
   * while an anchored mode (`pinned` or `reading`) is active. Deliberately NOT
   * `scrollTop`: a pin can scroll smoothly, so for the length of that animation
   * the live `scrollTop` is still somewhere in between, and deriving from it
   * would collapse the spacer mid-flight and clamp the animation short of the
   * top.
   *
   * Null in follow/free.
   */
  pinTop: number | null;
}

/** Everything the reducer is allowed to know about the DOM. */
export interface Geometry {
  clientHeight: number;
  /** Includes the spacer currently applied. */
  scrollHeight: number;
  scrollTop: number;
  /** Height of the reserved blank as it stands right now. */
  spacer: number;
}

export type ScrollEvent =
  /** A send: park `top` at the top of the viewport and reserve room below it. */
  | { type: 'pin'; top: number }
  /** Rows appended/changed/re-rendered — the transcript's height moved. */
  | { type: 'content' }
  /** The scroller's own box changed: resize, soft keyboard, tab became visible. */
  | { type: 'viewport' }
  /** A real gesture — the reader is taking over. */
  | { type: 'release' }
  /** "Jump to latest": the end of the content, not the end of the scroller. */
  | { type: 'toEnd' }
  /** Return from a background tab at the start of the turn being generated. */
  | { type: 'readFrom'; top: number }
  /** The run finished: give the reserved blank back. */
  | { type: 'settle' }
  /** Another transcript is being shown here; drop everything. */
  | { type: 'reset' };

export interface ScrollAction {
  owner: ScrollOwner;
  spacer: number;
  /** null = do not move the viewport (the common case while streaming). */
  scrollTo: number | null;
  behavior: ScrollBehavior;
  /**
   * Apply the spacer AFTER the scroll has landed, instead of before it.
   *
   * Every other action reserves blank so a position becomes reachable, which
   * has to happen first. Reclaiming blank is the mirror image: the position the
   * viewport is leaving only exists while the blank is still standing, so
   * collapsing it first would make the browser clamp — the reader would be
   * teleported the distance the animation was supposed to cover.
   */
  deferSpacer?: boolean;
}

/** How close to the end still counts as being at it. */
export const AT_END_EPSILON = 50;

const FOLLOW: ScrollOwner = { mode: 'follow', pinTop: null };
const FREE: ScrollOwner = { mode: 'free', pinTop: null };

/** The transcript's own height, with the reserved blank taken back off. */
export function contentHeight(g: Geometry): number {
  return Math.max(0, g.scrollHeight - g.spacer);
}

/** The scroll offset that puts the last line of the transcript at the viewport's bottom. */
export function maxContentScroll(g: Geometry): number {
  return Math.max(0, contentHeight(g) - g.clientHeight);
}

/**
 * Exactly enough blank to make `top` a reachable scroll offset. See the header.
 *
 * The top of a scroller is reachable by definition, so a target of 0 needs
 * nothing — without that guard a transcript shorter than the viewport would
 * "need" a spacer to justify sitting at the top, and a one-message session
 * would open with a screen of blank under it.
 */
export function requiredSpacer(top: number, g: Geometry): number {
  if (top <= 0) return 0;
  return Math.max(0, top + g.clientHeight - contentHeight(g));
}

/**
 * Is the end of the transcript on screen? Loose on purpose — sitting inside the
 * reserved blank counts, because from there the last line IS visible. Used for
 * the "jump to latest" button, which would otherwise be armed permanently
 * during a perfectly normal pinned turn.
 */
export function isContentEndVisible(g: Geometry): boolean {
  return contentHeight(g) - g.scrollTop - g.clientHeight < AT_END_EPSILON;
}

/**
 * Is the viewport parked AT the end of the transcript? Two-sided, so the
 * reserved blank does NOT qualify. This is the one that may promote a reader
 * back to follow mode: the loose test above reports true from inside the blank,
 * and following from there would yank the viewport down by a spacer's worth of
 * pixels the moment the next token landed. That yank was symptom 3.
 */
export function isAtContentEnd(g: Geometry): boolean {
  return Math.abs(g.scrollTop - maxContentScroll(g)) < AT_END_EPSILON;
}

/** A scroller with no layout box (a hidden tab) measures nothing worth having. */
export function isLive(g: Geometry): boolean {
  return g.clientHeight > 0;
}

function follow(g: Geometry, behavior: ScrollBehavior = 'auto'): ScrollAction {
  return { owner: FOLLOW, spacer: 0, scrollTo: maxContentScroll(g), behavior };
}

/**
 * The whole scroll policy. Returns null when nothing should happen — either the
 * pane is hidden, or the event does not apply to the current mode.
 */
export function reduceScroll(
  owner: ScrollOwner,
  event: ScrollEvent,
  g: Geometry,
): ScrollAction | null {
  // A pane with no box: no measurement, no state change, no write. Coming back
  // into view fires 'viewport', which re-derives everything from real numbers.
  if (!isLive(g)) return null;

  switch (event.type) {
    case 'reset':
      // No scroll: the transcript being switched to loads its own content and
      // the 'content' event that follows places the viewport.
      return { owner: FOLLOW, spacer: 0, scrollTo: null, behavior: 'auto' };

    case 'toEnd':
      return follow(g, 'smooth');

    case 'readFrom': {
      // A background return belongs to the reader, not the stream. Keep the
      // turn start reachable even when the reply is shorter than a viewport.
      // Clamping to the natural content end would both land at the tail and
      // let the resulting scroll event silently restore follow mode.
      const top = event.top;
      return {
        owner: { mode: 'reading', pinTop: top },
        spacer: requiredSpacer(top, g),
        scrollTo: top,
        behavior: 'auto',
      };
    }

    case 'settle': {
      // Completion must not pull someone who returned to read from the start
      // down to the tail. Keep exactly the blank that still makes the anchored
      // position reachable; later content naturally consumes it.
      if (owner.mode === 'reading') {
        const top = owner.pinTop ?? g.scrollTop;
        return { owner, spacer: requiredSpacer(top, g), scrollTo: null, behavior: 'auto' };
      }
      // Nothing reserved, nothing to give back. Notably the case for a reader
      // who scrolled away into history: their position is theirs to keep.
      if (g.spacer <= 0) return null;
      // As much of the current position as still exists without the blank.
      // spacer > 0 means the viewport is parked past the end of the content, so
      // this is always the content end — but derive it rather than assume it.
      const top = Math.min(g.scrollTop, maxContentScroll(g));
      return {
        // Landing on the content end means the transcript is being followed
        // again: anything appended after the run (a background task's last
        // word) keeps the tail in view instead of quietly falling below it.
        owner: top >= maxContentScroll(g) ? FOLLOW : FREE,
        spacer: 0,
        scrollTo: top,
        // Reads as the page settling. An instant collapse here is what the pin
        // was built to avoid: up to a screen of movement landing on someone who
        // has just started reading the answer.
        behavior: 'smooth',
        deferSpacer: true,
      };
    }

    case 'pin': {
      const spacer = requiredSpacer(event.top, g);
      // Nothing to reserve means the turn is already within a viewport of the
      // end; plain follow lands in the same place without a second animation.
      if (spacer <= 0) return follow(g);
      return { owner: { mode: 'pinned', pinTop: event.top }, spacer, scrollTo: event.top, behavior: 'smooth' };
    }

    case 'release': {
      // Only an anchored position can be taken over. In follow/free the
      // position already decides the mode (see isAtContentEnd), and a gesture
      // that ends at the bottom must not become "free" merely because it was
      // a gesture.
      if (owner.mode !== 'pinned' && owner.mode !== 'reading') return null;
      // The blank stays for now, trimmed to what the reader's current position
      // needs. It cannot yank them: by construction it is never smaller than
      // that. From here it decays on its own — every 'content' event re-derives
      // it, so a growing reply eats it and scrolling up drops it.
      return { owner: FREE, spacer: requiredSpacer(g.scrollTop, g), scrollTo: null, behavior: 'auto' };
    }

    case 'content':
    case 'viewport': {
      if (owner.mode === 'follow') return follow(g);

      if (owner.mode === 'pinned') {
        const top = owner.pinTop ?? g.scrollTop;
        const spacer = requiredSpacer(top, g);
        // The reply outgrew the reserved space. The two positions have
        // converged exactly (spacer 0 ⇒ pinTop === maxContentScroll), so
        // handing back to follow is seamless.
        if (spacer <= 0) return follow(g);
        return {
          owner,
          spacer,
          // Re-assert the pin only when the viewport itself changed under it
          // (soft keyboard, tab shown again, pane resized). Never on content:
          // re-scrolling per token is what makes streaming views jitter, and
          // the constant-scrollHeight spacer means it is not needed.
          scrollTo: event.type === 'viewport' ? top : null,
          behavior: 'auto',
        };
      }

      if (owner.mode === 'reading') {
        const top = owner.pinTop ?? g.scrollTop;
        return {
          owner,
          spacer: requiredSpacer(top, g),
          // Streaming never chases the tail. Only re-assert the stored offset
          // when the viewport itself changes underneath it.
          scrollTo: event.type === 'viewport' ? top : null,
          behavior: 'auto',
        };
      }

      // free: hold the reader's position and let the blank decay under it.
      return { owner, spacer: requiredSpacer(g.scrollTop, g), scrollTo: null, behavior: 'auto' };
    }
  }
}

/**
 * The mode a position implies when no explicit anchor owns the viewport.
 */
export function modeForPosition(g: Geometry): ScrollOwner {
  return isAtContentEnd(g) ? FOLLOW : FREE;
}

/** Programmatic scroll events cannot release an explicit anchored position. */
export function ownerForPosition(owner: ScrollOwner, g: Geometry): ScrollOwner {
  if (owner.mode === 'pinned' || owner.mode === 'reading') return owner;
  return modeForPosition(g);
}
