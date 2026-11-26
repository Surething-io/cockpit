'use client';

import Image from 'next/image';
import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import tour from '@/content/tour-frames.json';

/**
 * The homepage hero: a short guided tour over real product frames.
 *
 * The frames and their focus rects come from `npm run tour`
 * (scripts/tour/capture.mjs), which drives the current build against fictional
 * seeded data — so refreshing the hero after a UI change is one command, not a
 * hand-made screenshot.
 *
 * Each chapter plays in three beats, all CSS transitions:
 *   1. the frame cross-fades in, cursor where the previous chapter left it;
 *   2. the cursor travels to the control it "clicks" and pulses;
 *   3. the rest of the frame dims and the camera zooms toward the focus rect.
 *
 * Below `md` the frame is ~340px wide, so the zoom is much stronger there:
 * the focused region is what a phone visitor needs to be able to read.
 *
 * Keeps playing under the mouse — it is the page's demo, and stopping whenever
 * the pointer drifts over it made it look stuck. Pauses on keyboard focus,
 * off-screen and in background tabs, and has an explicit pause button (moving
 * content longer than 5s needs one).
 * With `prefers-reduced-motion` it never autoplays and never moves: chapters
 * switch on click and show the highlight without zoom or cursor.
 */

type Rect = { x: number; y: number; w: number; h: number };
type Frame = { id: string; src: string; zoom: number; focus: Rect; cursor: { x: number; y: number } };

const FRAMES = tour.frames as Frame[];
const CHAPTER_MS = 4500;
const POINT_AT = 250;
const FOCUS_AT = 950;
/** Zoom applied below `md` regardless of the frame's own, so text is legible. */
const NARROW_ZOOM = 2.3;
/** Where the cursor rests before the first chapter has pointed anywhere. */
const CURSOR_HOME = { x: 50, y: 62 };

type Phase = 'enter' | 'point' | 'focus';

export type TourCopy = {
  label: string;
  play: string;
  pause: string;
  chapters: { title: string; caption: string; alt: string }[];
};

function useMedia(query: string, initial: boolean) {
  const [matches, setMatches] = useState(initial);
  useEffect(() => {
    const mq = window.matchMedia(query);
    const sync = () => setMatches(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, [query]);
  return matches;
}

export function HeroTour({ copy }: { copy: TourCopy }) {
  const reduced = useMedia('(prefers-reduced-motion: reduce)', false);
  const narrow = useMedia('(max-width: 767px)', false);

  const [index, setIndex] = useState(0);
  const [phase, setPhase] = useState<Phase>('enter');
  /** Bumped on every chapter start, so the progress bar restarts even when a
   *  click re-selects the chapter already showing. */
  const [run, setRun] = useState(0);
  /** Where the current chapter's clock started, for the progress bar to match. */
  const [startAt, setStartAt] = useState(0);
  const [userPaused, setUserPaused] = useState(false);
  const [focused, setFocused] = useState(false);
  const [onScreen, setOnScreen] = useState(true);
  const [pageVisible, setPageVisible] = useState(true);

  const rootRef = useRef<HTMLDivElement>(null);
  // Time already spent in the current chapter, so a pause resumes mid-chapter
  // instead of restarting it.
  const elapsedRef = useRef(0);

  const playing = !reduced && !userPaused && !focused && onScreen && pageVisible;

  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const io = new IntersectionObserver(([entry]) => setOnScreen(entry.isIntersecting), { threshold: 0.25 });
    io.observe(node);
    const onVis = () => setPageVisible(document.visibilityState === 'visible');
    document.addEventListener('visibilitychange', onVis);
    return () => {
      io.disconnect();
      document.removeEventListener('visibilitychange', onVis);
    };
  }, []);

  // The chapter clock. One rAF loop that only touches React state when the
  // phase or chapter actually changes.
  useEffect(() => {
    if (!playing) return;
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      elapsedRef.current += now - last;
      last = now;
      const t = elapsedRef.current;
      if (t >= CHAPTER_MS) {
        elapsedRef.current = 0;
        setPhase('enter');
        setIndex((i) => (i + 1) % FRAMES.length);
        setRun((r) => r + 1);
        setStartAt(0);
      } else {
        setPhase(t >= FOCUS_AT ? 'focus' : t >= POINT_AT ? 'point' : 'enter');
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [playing]);

  // A chapter picked while paused (pause button, keyboard focus)
  // would otherwise sit on its first beat; show it fully revealed instead.
  const goTo = useCallback((i: number) => {
    const start = playing ? 0 : FOCUS_AT;
    elapsedRef.current = start;
    setStartAt(start);
    setPhase(playing ? 'enter' : 'focus');
    setIndex(i);
    setRun((r) => r + 1);
  }, [playing]);

  // Reduced motion: a static, fully revealed chapter.
  const shownPhase: Phase = reduced ? 'focus' : phase;
  const prev = FRAMES[(index - 1 + FRAMES.length) % FRAMES.length];
  const chapter = copy.chapters[index];

  return (
    <div className="mx-auto mt-12 max-w-5xl text-left">
      <div
        ref={rootRef}
        role="region"
        aria-roledescription="carousel"
        aria-label={copy.label}
        // Keyboard focus on a chapter only: a mouse click focuses its button too,
        // which must not freeze the tour, and the play/pause toggle says for
        // itself whether it is playing.
        onFocus={(e) => setFocused(e.target.matches('[role=tab]:focus-visible'))}
        onBlur={(e) => {
          if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setFocused(false);
        }}
        className="overflow-hidden rounded-2xl border border-border bg-slate-1 shadow-2xl ring-1 ring-white/[0.06]"
      >
        <div className="group relative aspect-[16/10] overflow-hidden">
          {FRAMES.map((frame, i) => (
            <TourFrame
              key={frame.id}
              frame={frame}
              alt={copy.chapters[i]?.alt ?? ''}
              active={i === index}
              phase={i === index ? shownPhase : 'enter'}
              narrow={narrow}
              // Inactive frames park their cursor where the active one points,
              // so the next chapter starts from there instead of jumping.
              cursorFrom={i !== index ? FRAMES[index].cursor : run === 0 ? CURSOR_HOME : prev.cursor}
              showCursor={!reduced}
              animate={!reduced}
              priority={i === 0}
            />
          ))}
          {/* Play / pause like a video: the whole stage is the hit target, and the
              round button in the middle appears on hover (always while paused,
              since touch screens have no hover to reveal it). */}
          {!reduced && (
            <button
              type="button"
              onClick={() => setUserPaused((p) => !p)}
              aria-label={userPaused ? copy.play : copy.pause}
              title={userPaused ? copy.play : copy.pause}
              className="group/toggle absolute inset-0 flex cursor-pointer items-center justify-center focus-visible:outline-none"
            >
              <span
                className={`flex h-16 w-16 items-center justify-center rounded-full bg-black/60 text-white shadow-lg ring-1 ring-white/15 backdrop-blur-sm transition-opacity duration-200 group-hover:opacity-100 group-focus-visible/toggle:opacity-100 group-focus-visible/toggle:ring-2 group-focus-visible/toggle:ring-brand ${
                  userPaused ? 'opacity-100' : 'opacity-0'
                }`}
              >
                {userPaused ? <PlayIcon size={26} /> : <PauseIcon size={24} />}
              </span>
            </button>
          )}
        </div>

        <div className="border-t border-border px-4 py-3 md:px-5">
          <div className="flex items-center gap-3">
            <div role="tablist" aria-label={copy.label} className="flex flex-1 gap-1.5 md:gap-2">
              {copy.chapters.map((c, i) => (
                <button
                  key={c.title}
                  type="button"
                  role="tab"
                  aria-selected={i === index}
                  onClick={() => goTo(i)}
                  className={`group flex-1 rounded-md py-1.5 text-left text-xs font-medium transition-colors md:text-sm ${
                    i === index ? 'text-foreground' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  <span className="block truncate px-0.5">{c.title}</span>
                  <span className="mt-1.5 block h-0.5 overflow-hidden rounded-full bg-border">
                    <span
                      key={i === index ? `run-${run}` : 'off'}
                      className="block h-full origin-left bg-brand"
                      style={progressStyle(i, index, reduced, playing, startAt)}
                    />
                  </span>
                </button>
              ))}
            </div>
          </div>
          <p className="mt-2 min-h-[2.5rem] text-sm leading-relaxed text-muted-foreground md:min-h-0">{chapter?.caption}</p>
        </div>
      </div>
    </div>
  );
}

function progressStyle(i: number, index: number, reduced: boolean, playing: boolean, startAt: number): CSSProperties {
  if (i < index || (reduced && i === index)) return { transform: 'scaleX(1)' };
  if (i > index) return { transform: 'scaleX(0)' };
  return {
    transform: 'scaleX(0)',
    animation: `tour-progress ${CHAPTER_MS}ms linear -${startAt}ms forwards`,
    animationPlayState: playing ? 'running' : 'paused',
  };
}

function TourFrame({
  frame,
  alt,
  active,
  phase,
  narrow,
  cursorFrom,
  showCursor,
  animate,
  priority,
}: {
  frame: Frame;
  alt: string;
  active: boolean;
  phase: Phase;
  narrow: boolean;
  cursorFrom: { x: number; y: number };
  showCursor: boolean;
  animate: boolean;
  priority: boolean;
}) {
  const { focus, cursor } = frame;
  const focusing = active && phase === 'focus';
  const camera = focusing ? cameraFor(focus, frame.zoom, narrow) : { scale: 1, tx: 0, ty: 0 };
  const scale = camera.scale;
  const at = active && phase !== 'enter' ? cursor : cursorFrom;

  return (
    <div
      aria-hidden={!active}
      className="absolute inset-0 transition-opacity duration-500"
      style={{ opacity: active ? 1 : 0 }}
    >
      <div
        className="absolute inset-0"
        style={{
          transform: `translate(${camera.tx}%, ${camera.ty}%) scale(${scale})`,
          transformOrigin: '0 0',
          transition: animate ? 'transform 0.9s cubic-bezier(0.4, 0, 0.2, 1)' : undefined,
        }}
      >
        <Image
          src={frame.src}
          alt={alt}
          fill
          priority={priority}
          sizes="(max-width: 767px) 100vw, 1024px"
          className="object-cover"
        />
        {/* Dims everything outside the focus rect. */}
        <div
          aria-hidden
          className="pointer-events-none absolute rounded-md ring-2 ring-brand/80 transition-opacity duration-500"
          style={{
            left: `${focus.x}%`,
            top: `${focus.y}%`,
            width: `${focus.w}%`,
            height: `${focus.h}%`,
            opacity: focusing ? 1 : 0,
            boxShadow: '0 0 0 9999px rgb(0 0 0 / 0.45)',
          }}
        />
        {showCursor && (
          <div
            aria-hidden
            className="pointer-events-none absolute"
            style={{
              left: `${at.x}%`,
              top: `${at.y}%`,
              // Counter-scale so the cursor keeps its size while the camera zooms.
              transform: `scale(${1 / scale})`,
              transformOrigin: '0 0',
              transition: 'left 0.6s cubic-bezier(0.4, 0, 0.2, 1), top 0.6s cubic-bezier(0.4, 0, 0.2, 1), transform 0.9s cubic-bezier(0.4, 0, 0.2, 1)',
              opacity: active ? 1 : 0,
            }}
          >
            {active && phase !== 'enter' && (
              <span key={frame.id} className="tour-click absolute -left-4 -top-4 h-8 w-8 rounded-full bg-brand/40" />
            )}
            <CursorIcon />
          </div>
        )}
      </div>
    </div>
  );
}

/**
 * Scale and offset (in % of the stage) that bring the focus rect to the centre.
 * On wide screens the scale is capped so the whole rect stays in view with a
 * margin; on phones legibility wins and the rect may be cropped. Either way the
 * offset is clamped so the image always covers the stage.
 */
function cameraFor(focus: Rect, zoom: number, narrow: boolean) {
  const fit = Math.min(88 / focus.w, 88 / focus.h);
  const scale = Math.max(1, narrow ? Math.max(NARROW_ZOOM, zoom) : Math.min(zoom, fit));
  const clamp = (v: number) => Math.min(0, Math.max(100 - 100 * scale, v));
  return {
    scale,
    tx: clamp(50 - (focus.x + focus.w / 2) * scale),
    ty: clamp(50 - (focus.y + focus.h / 2) * scale),
  };
}

function CursorIcon() {
  return (
    <svg width="20" height="22" viewBox="0 0 20 22" className="relative drop-shadow-[0_2px_4px_rgba(0,0,0,0.5)]">
      <path d="M2 1.5v16.2l4.3-4.1 2.9 6.6 2.9-1.3-2.9-6.5h6.1z" fill="white" stroke="black" strokeWidth="1.2" strokeLinejoin="round" />
    </svg>
  );
}

function PauseIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <rect x="6" y="4" width="4" height="16" rx="1" />
      <rect x="14" y="4" width="4" height="16" rx="1" />
    </svg>
  );
}

function PlayIcon({ size }: { size: number }) {
  return (
    <svg width={size} height={size} className="translate-x-0.5" viewBox="0 0 24 24" fill="currentColor" aria-hidden focusable="false">
      <path d="M7 4.5v15a1 1 0 0 0 1.5.86l12-7.5a1 1 0 0 0 0-1.72l-12-7.5A1 1 0 0 0 7 4.5z" />
    </svg>
  );
}
