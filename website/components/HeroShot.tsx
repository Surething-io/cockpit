'use client';

import Image from 'next/image';
import { useCallback, useEffect, useState } from 'react';

/**
 * The hero screenshot.
 *
 * Below `md` the shot is held at a legible 1080px inside a horizontally
 * pannable frame rather than scaled down to ~342px, where its body text would
 * render at roughly 3px. Three things the first version of that got wrong, all
 * handled here:
 *
 * 1. **It opened on the wrong pixels.** At `scrollLeft: 0` the 31% a phone
 *    visitor ever saw was the window chrome and the project sidebar, so the
 *    page's entire proof asset was telling a story about a file browser. It now
 *    opens on the agent conversation.
 * 2. **Nothing said it panned.** No scrollbar (`scrollbar-width: none`), no edge
 *    treatment, and the hint rendered 640px below the frame's top edge —
 *    off-screen at first contact. The hint is above the frame now and the right
 *    edge fades.
 * 3. **It was focusable where it cannot scroll.** `tabIndex` and `role=group`
 *    were applied at every width, putting a focus stop and a teal focus ring on
 *    an inert element above `md`.
 */

/** Left edge of the chat column in the 2048px capture, scaled to the 1080px the
 *  image renders at below `md`. */
const INITIAL_SCROLL = 340;

const MD = '(min-width: 768px)';

export function HeroShot({
  src,
  alt,
  groupLabel,
  hint,
}: {
  src: string;
  alt: string;
  groupLabel: string;
  hint: string;
}) {
  // Default to the pannable (mobile) markup so server and first client render
  // agree; the effect narrows it once we can measure.
  const [pannable, setPannable] = useState(true);

  useEffect(() => {
    const mq = window.matchMedia(MD);
    const sync = () => setPannable(!mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  // A ref callback rather than an effect: this runs during commit, before the
  // browser paints, so the frame is never seen at scrollLeft 0 first.
  const frameRef = useCallback((node: HTMLDivElement | null) => {
    if (node && node.scrollWidth > node.clientWidth) {
      node.scrollLeft = INITIAL_SCROLL;
    }
  }, []);

  return (
    <div className="mx-auto mt-12 max-w-5xl">
      {/* Above the frame, not below it: a drag hint the reader meets after the
          thing it explains is not a hint. */}
      <p className="mb-3 text-xs text-muted-foreground md:hidden">{hint}</p>
      <div className="relative">
        <div
          ref={frameRef}
          tabIndex={pannable ? 0 : undefined}
          role={pannable ? 'group' : undefined}
          /* Names the interaction. The image keeps its own descriptive `alt`, so
             labelling the group with the same string made a screen reader read
             the same 100 characters twice in a row. */
          aria-label={pannable ? groupLabel : undefined}
          className="overflow-x-auto overflow-y-hidden overscroll-x-contain rounded-2xl border border-border shadow-2xl ring-1 ring-white/[0.06] md:overflow-hidden"
        >
          <Image
            src={src}
            alt={alt}
            width={2048}
            height={1190}
            priority
            sizes="(max-width: 767px) 1080px, 1024px"
            className="h-auto w-[1080px] max-w-none md:w-full"
          />
        </div>
        {/* The only remaining cue that the frame continues, now that the
            scrollbar is suppressed. */}
        <div
          aria-hidden
          className="pointer-events-none absolute inset-y-px right-px w-14 rounded-r-2xl bg-gradient-to-l from-slate-1 via-slate-1/60 to-transparent md:hidden"
        />
      </div>
    </div>
  );
}
