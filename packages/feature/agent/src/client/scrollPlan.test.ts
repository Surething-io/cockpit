import { describe, it, expect } from 'vitest';
import {
  reduceScroll,
  modeForPosition,
  requiredSpacer,
  maxContentScroll,
  isAtContentEnd,
  isContentEndVisible,
  type Geometry,
  type ScrollOwner,
  type ScrollEvent,
} from './scrollPlan';

/**
 * A scroller, simulated exactly as a browser treats one: `scrollHeight` is
 * content + spacer, and any scrollTop past `scrollHeight - clientHeight` is
 * silently clamped. The clamp is the whole point — it is what turned a stale
 * spacer into a viewport that jumped, so the tests assert against it rather
 * than around it.
 */
class Scroller {
  contentH: number;
  clientH: number;
  scrollTop = 0;
  spacer = 0;
  owner: ScrollOwner = { mode: 'follow', pinTop: null };
  /** Set when a plan asked for a position the layout could not deliver. */
  clamped = false;

  constructor(contentH: number, clientH: number) {
    this.contentH = contentH;
    this.clientH = clientH;
  }

  geometry(): Geometry {
    return {
      clientHeight: this.clientH,
      scrollHeight: this.contentH + this.spacer,
      scrollTop: this.scrollTop,
      spacer: this.spacer,
    };
  }

  maxScroll(): number {
    return Math.max(0, this.contentH + this.spacer - this.clientH);
  }

  /** Returns whether the event produced a plan at all. */
  send(event: ScrollEvent): boolean {
    const action = reduceScroll(this.owner, event, this.geometry());
    if (!action) return false;
    this.owner = action.owner;
    // Order mirrors dispatchScroll(): reserving blank lands before the scroll,
    // reclaiming it lands after — which is what makes the reclaim animatable.
    if (!action.deferSpacer) this.spacer = action.spacer;
    let max = this.maxScroll();
    if (action.scrollTo !== null) {
      if (action.scrollTo > max + 0.5) this.clamped = true;
      this.scrollTop = Math.min(Math.max(0, action.scrollTo), max);
    } else if (this.scrollTop > max) {
      // The browser dragging the viewport along as the scroller shrank: a
      // visible jump the reader did not ask for.
      this.clamped = true;
      this.scrollTop = max;
    }
    if (action.deferSpacer) {
      this.spacer = action.spacer;
      max = this.maxScroll();
      if (this.scrollTop > max) {
        this.clamped = true;
        this.scrollTop = max;
      }
    }
    return true;
  }

  /** Grow the transcript, as a streamed delta does. */
  grow(px: number) {
    this.contentH += px;
  }

  /** Where the top of the viewport sits inside the CONTENT. */
  readingPosition(): number {
    return this.scrollTop;
  }
}

const VIEWPORT = 800;

describe('geometry helpers', () => {
  const g: Geometry = { clientHeight: 800, scrollHeight: 1500, scrollTop: 700, spacer: 500 };

  it('measures the content, not the scroller', () => {
    expect(maxContentScroll(g)).toBe(200); // (1500 - 500) - 800
  });

  it('reserves exactly what a position needs', () => {
    expect(requiredSpacer(700, g)).toBe(500); // 700 + 800 - 1000
    expect(requiredSpacer(200, g)).toBe(0);
    expect(requiredSpacer(0, g)).toBe(0);
  });

  it('separates "the end is on screen" from "parked at the end"', () => {
    // Sitting inside the reserved blank: the last line IS visible…
    expect(isContentEndVisible(g)).toBe(true);
    // …but the viewport is a spacer's worth PAST the end, so following from
    // here would move it. This is the distinction symptom 3 was missing.
    expect(isAtContentEnd(g)).toBe(false);
    expect(modeForPosition(g).mode).toBe('free');
  });
});

describe('pin — a send parks the turn at the top', () => {
  it('reserves room and lands the row at the viewport top', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.scrollTop = 1200; // was following the tail
    s.send({ type: 'pin', top: 1900 });

    expect(s.owner.mode).toBe('pinned');
    expect(s.scrollTop).toBe(1900);
    expect(s.clamped).toBe(false);
    // Enough blank for the row to reach the top, and not a pixel more.
    expect(s.spacer).toBe(700); // 1900 + 800 - 2000
  });

  it('falls back to follow when the turn is already within a viewport of the end', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1000 });
    expect(s.owner.mode).toBe('follow');
    expect(s.spacer).toBe(0);
    expect(s.scrollTop).toBe(1200);
  });
});

describe('hold — streaming into the reserved blank', () => {
  it('never moves the viewport and keeps scrollHeight constant', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    const heightBefore = s.contentH + s.spacer;

    for (let i = 0; i < 20; i += 1) {
      s.grow(30);
      s.send({ type: 'content' });
      expect(s.scrollTop).toBe(1900);
      expect(s.contentH + s.spacer).toBe(heightBefore);
      expect(s.clamped).toBe(false);
    }
    expect(s.spacer).toBe(700 - 600);
  });

  it('hands back to follow at the exact pixel the reply outgrows the reserve', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });

    s.grow(700);
    s.send({ type: 'content' });

    expect(s.owner.mode).toBe('follow');
    expect(s.spacer).toBe(0);
    // Seamless: the position it hands over at is the position it was holding.
    expect(s.scrollTop).toBe(1900);
    expect(s.clamped).toBe(false);
  });

  it('keeps holding while a smooth pin animation is still in flight', () => {
    // The reducer derives from pinTop, not from the live scrollTop, so a
    // measurement taken mid-animation returns the same reserve.
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.scrollTop = 1500; // animation half way there
    s.send({ type: 'content' });
    expect(s.spacer).toBe(700);
    expect(s.owner.mode).toBe('pinned');
  });
});

describe('release — the reader takes over', () => {
  it('does not jump, and the blank decays instead of being yanked away', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });

    const before = s.readingPosition();
    s.send({ type: 'release' });

    expect(s.owner.mode).toBe('free');
    expect(s.readingPosition()).toBe(before); // no jump at the moment of release
    expect(s.clamped).toBe(false);

    // Every delta trims the blank to what the position still needs…
    for (let i = 0; i < 10; i += 1) {
      s.grow(50);
      s.send({ type: 'content' });
      expect(s.readingPosition()).toBe(before); // …and never moves the reader
      expect(s.clamped).toBe(false);
    }
    expect(s.spacer).toBe(200); // 700 - 500
  });

  it('drops the blank entirely once the reply fills the viewport', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'release' });
    s.grow(2000);
    s.send({ type: 'content' });
    expect(s.spacer).toBe(0);
    expect(s.readingPosition()).toBe(1900);
  });

  it('scrolling up shrinks the blank without the viewport noticing', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'release' });
    s.scrollTop = 1400; // reader scrolls up by 500
    s.send({ type: 'content' });
    expect(s.spacer).toBe(200);
    expect(s.scrollTop).toBe(1400);
    expect(s.clamped).toBe(false);
  });

  it('is a no-op outside a pin, so a gesture that ends at the tail keeps following', () => {
    const s = new Scroller(2000, VIEWPORT);
    expect(s.send({ type: 'release' })).toBe(false);
    expect(s.owner.mode).toBe('follow');
  });
});

describe('regression — the three reported symptoms', () => {
  it('symptom 3: a stream cannot re-pin the reader to the top after a gesture', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'release' });

    // The old code promoted this position to `follow` (its at-bottom test
    // subtracted the spacer) and then wrote scrollTop = scrollHeight, which
    // the pin formula made equal to the pinned offset — every token.
    expect(modeForPosition(s.geometry()).mode).toBe('free');

    const reader = 1500;
    s.scrollTop = reader;
    for (let i = 0; i < 40; i += 1) {
      s.grow(25);
      s.send({ type: 'content' });
    }
    expect(s.scrollTop).toBe(reader);
  });

  it('symptom 1: no blank survives a reply that grew past it', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'release' }); // reader scrolls during the stream
    for (let i = 0; i < 60; i += 1) {
      s.grow(40);
      s.send({ type: 'content' });
    }
    expect(s.spacer).toBe(0);
    // …and the end of the transcript is genuinely reachable again.
    s.send({ type: 'toEnd' });
    expect(s.scrollTop).toBe(s.contentH - s.clientH);
    expect(s.spacer).toBe(0);
  });

  it('symptom 2: a hidden pane measures nothing and freezes nothing', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    const spacerWhenHidden = s.spacer;

    s.clientH = 0; // display:none — every rect reads 0
    for (const event of [
      { type: 'content' },
      { type: 'viewport' },
      { type: 'release' },
      { type: 'toEnd' },
      { type: 'pin', top: 0 },
      { type: 'reset' },
    ] as ScrollEvent[]) {
      expect(reduceScroll(s.owner, event, s.geometry())).toBeNull();
    }

    // The run kept streaming while the tab was away.
    s.grow(5000);
    s.clientH = VIEWPORT; // tab comes back
    expect(s.spacer).toBe(spacerWhenHidden); // untouched, not self-confirmed
    s.send({ type: 'viewport' });

    // One event with real numbers is all it takes to reclaim it.
    expect(s.spacer).toBe(0);
    expect(s.owner.mode).toBe('follow');
    expect(s.clamped).toBe(false);
  });
});

describe('readFrom — returning from a background tab', () => {
  it('restores a long turn to its start and leaves streaming under reader control', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.scrollTop = 1200;
    s.send({ type: 'pin', top: 1900 });

    // The reply grew while the pane had no live geometry, so no content event
    // was dispatched and the original pin is still standing.
    s.grow(3000);
    s.send({ type: 'readFrom', top: 1900 });

    expect(s.owner.mode).toBe('free');
    expect(s.scrollTop).toBe(1900);
    expect(s.spacer).toBe(0);
    expect(s.clamped).toBe(false);

    s.grow(200);
    s.send({ type: 'content' });
    expect(s.scrollTop).toBe(1900);
  });

  it('shows an entire short turn without retaining the pin spacer', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.scrollTop = 1200;
    s.send({ type: 'pin', top: 1900 });
    s.grow(300);

    s.send({ type: 'readFrom', top: 1900 });

    expect(s.owner.mode).toBe('free');
    expect(s.scrollTop).toBe(1500); // natural content end: 2300 - 800
    expect(s.spacer).toBe(0);
    expect(s.clamped).toBe(false);
  });
});

describe('viewport changes', () => {
  it('re-establishes a pin when the soft keyboard steals height', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.clientH = 400;
    s.send({ type: 'viewport' });
    expect(s.owner.mode).toBe('pinned');
    expect(s.scrollTop).toBe(1900);
    expect(s.spacer).toBe(300); // 1900 + 400 - 2000
    expect(s.clamped).toBe(false);
  });

  it('re-glues a following tab that grew while it was hidden', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'content' });
    expect(s.scrollTop).toBe(1200);
    s.clientH = 0;
    s.grow(1000);
    expect(s.send({ type: 'content' })).toBe(false);
    s.clientH = VIEWPORT;
    s.send({ type: 'viewport' });
    expect(s.scrollTop).toBe(2200);
  });
});

describe('settle — the run finished, give the blank back', () => {
  it('glides to the content end and leaves nothing reserved', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.grow(300); // a short answer: 400px of the reserve is still blank
    s.send({ type: 'content' });
    expect(s.spacer).toBe(400);

    s.send({ type: 'settle' });

    expect(s.spacer).toBe(0);
    expect(s.scrollTop).toBe(1500); // 2300 - 800: the answer ends at the fold
    expect(s.owner.mode).toBe('follow');
    // The blank is reclaimed AFTER the scroll, so the reader is not teleported
    // the distance the animation was there to cover.
    expect(s.clamped).toBe(false);
  });

  it('is animated, and only reclaims — it never scrolls further down', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    const action = reduceScroll(s.owner, { type: 'settle' }, s.geometry());
    expect(action?.behavior).toBe('smooth');
    expect(action?.deferSpacer).toBe(true);
    expect(action?.scrollTo).toBe(maxContentScroll(s.geometry()));
  });

  it('leaves a reader who scrolled away into history alone', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'release' });
    s.scrollTop = 200; // reading something far above
    s.send({ type: 'content' }); // the blank is already gone at this position
    expect(s.spacer).toBe(0);
    expect(reduceScroll(s.owner, { type: 'settle' }, s.geometry())).toBeNull();
    expect(s.scrollTop).toBe(200);
  });

  it('reclaims a blank the reader is still parked in after taking over', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'release' });
    expect(s.spacer).toBe(700);
    s.send({ type: 'settle' });
    expect(s.spacer).toBe(0);
    expect(s.scrollTop).toBe(1200);
    expect(s.clamped).toBe(false);
  });

  it('does nothing at all when a long reply already used the reserve up', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.grow(3000);
    s.send({ type: 'content' });
    const before = s.scrollTop;
    expect(s.send({ type: 'settle' })).toBe(false);
    expect(s.scrollTop).toBe(before);
  });

  it('is a no-op on a hidden pane, so the caller can retry on the way back in', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.clientH = 0;
    expect(reduceScroll(s.owner, { type: 'settle' }, s.geometry())).toBeNull();
    s.clientH = VIEWPORT;
    expect(s.send({ type: 'settle' })).toBe(true);
    expect(s.spacer).toBe(0);
  });
});

describe('reset and jump-to-latest', () => {
  it('reset drops the blank without moving anything', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'reset' });
    expect(s.owner.mode).toBe('follow');
    expect(s.spacer).toBe(0);
    // Clamping here is the transcript being swapped out, not a reader being
    // moved; what matters is that no blank crosses into the next session.
    expect(s.contentH + s.spacer).toBe(2000);
  });

  it('jump-to-latest means the end of the content, not the end of the scroller', () => {
    const s = new Scroller(2000, VIEWPORT);
    s.send({ type: 'pin', top: 1900 });
    s.send({ type: 'toEnd' });
    expect(s.spacer).toBe(0);
    expect(s.scrollTop).toBe(1200);
    expect(s.owner.mode).toBe('follow');
  });
});

describe('invariants over random event sequences', () => {
  // `reset` is excluded on purpose: it belongs to a transcript being swapped
  // out, so the position it leaves behind is meaningless and its clamp is not a
  // reader being moved. It has its own test above.
  const EVENTS: ScrollEvent[] = [
    { type: 'content' },
    { type: 'viewport' },
    { type: 'release' },
    { type: 'toEnd' },
    { type: 'settle' },
  ];

  it('holds I1 (spacer is never more than the position needs) and never clamps', () => {
    // Deterministic LCG so a failure is reproducible.
    let seed = 12345;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;

    for (let run = 0; run < 200; run += 1) {
      const s = new Scroller(500 + Math.floor(rnd() * 4000), 300 + Math.floor(rnd() * 600));
      for (let step = 0; step < 40; step += 1) {
        const roll = rnd();
        let planned: boolean;
        if (roll < 0.15) {
          planned = s.send({ type: 'pin', top: Math.max(0, s.contentH - Math.floor(rnd() * 900)) });
        } else if (roll < 0.3) {
          // The reader moves by hand, and the position decides the mode —
          // exactly what handleScroll does. No plan runs, so the blank is
          // allowed to be larger than needed until the next event trims it.
          s.scrollTop = Math.min(Math.max(0, Math.floor(rnd() * s.contentH)), s.maxScroll());
          if (s.owner.mode !== 'pinned') s.owner = modeForPosition(s.geometry());
          planned = false;
        } else if (roll < 0.6) {
          s.grow(Math.floor(rnd() * 200));
          planned = s.send({ type: 'content' });
        } else {
          planned = s.send(EVENTS[Math.floor(rnd() * EVENTS.length)]);
        }

        if (planned) {
          // I1: the blank is exactly what the held position needs — never the
          // leftover of a position that is no longer current.
          const target = s.owner.mode === 'pinned' ? (s.owner.pinTop ?? s.scrollTop) : s.scrollTop;
          expect(s.spacer).toBe(requiredSpacer(target, s.geometry()));
          // I2: follow never carries a blank.
          if (s.owner.mode === 'follow') expect(s.spacer).toBe(0);
        }
        // I3: nothing the reducer asked for was out of range, and no plan ever
        // shrank the scroller out from under the reader.
        expect(s.clamped).toBe(false);
      }
    }
  });
});
