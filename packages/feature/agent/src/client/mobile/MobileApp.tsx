'use client';

import { useState, useCallback, useEffect, useRef } from 'react';
import { MobileSessionList, type OpenableSession } from './MobileSessionList';
import { MobileChat } from './MobileChat';
import type { GlobalSession } from '../GlobalSessionMonitor';

// Root of the mobile experience (/m). Two screens — recent-session list and a
// single chat — laid out SIDE BY SIDE in a 2-page track. We own the horizontal
// swipe entirely (finger-following translateX) rather than leaning on the browser's
// native back-gesture: the native gesture screenshots the previous history entry,
// but with a single same-URL SPA both entries paint the same page, so the gesture
// reveals a stale "current screen" before the real target pops in (the "double
// slide"). A real side-by-side track has both screens painted, so the pan is
// genuine. `overscroll-behavior-x: none` suppresses the browser's competing
// swipe-nav; history is still synced so the system Back button + deep links work.
interface MobileAppProps {
  // Optional deep-link from the redirect (preserved query params).
  initialCwd?: string;
  initialSessionId?: string;
  // SSR-provided session-list snapshot (see MobileSessionList.initialSessions).
  initialSessions?: GlobalSession[];
}

interface OpenSession {
  cwd: string;
  sessionId: string;
  title?: string;
}

// Marker stamped on the history entry pushed when a chat opens, so popstate
// (system Back/Forward button) can tell chat-entry from list-entry.
const CHAT_MARKER = 'cockpitMobileChat';
// Fraction of page width a drag must pass to commit the page switch on release.
const COMMIT_FRACTION = 0.25;

export function MobileApp({ initialCwd, initialSessionId, initialSessions }: MobileAppProps) {
  // The session loaded into the chat page. Both pages stay mounted, so swiping
  // back to the list never re-fetches the chat's history. Replaced only when a
  // different session is opened (key change → genuine remount).
  const [active, setActive] = useState<OpenSession | null>(
    initialCwd && initialSessionId
      ? { cwd: initialCwd, sessionId: initialSessionId }
      : null,
  );
  // Which page is settled on-screen (false = list, true = chat).
  const [showChat, setShowChat] = useState(Boolean(initialCwd && initialSessionId));
  // Live finger-drag offset in px (0 when settled). Drives the track transform.
  const [dragOffset, setDragOffset] = useState(0);
  // True while a horizontal drag is in progress → disables the snap transition so
  // the track follows the finger 1:1.
  const [dragging, setDragging] = useState(false);
  const [pageWidth, setPageWidth] = useState(0);

  const pushedRef = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);
  // Mirror reactive values into refs so the imperative (non-passive) touch
  // listeners always read fresh state without re-binding on every change.
  const showChatRef = useRef(showChat);
  showChatRef.current = showChat;
  const activeRef = useRef(active);
  activeRef.current = active;
  const pageWidthRef = useRef(pageWidth);
  pageWidthRef.current = pageWidth;

  // Enter / exit the chat page. Both update the view immediately (so OUR transition
  // animates the slide) and keep browser history in sync for the system Back button.
  const enterChat = useCallback(() => {
    if (!activeRef.current) return;
    setShowChat(true);
    if (!pushedRef.current) {
      window.history.pushState({ [CHAT_MARKER]: activeRef.current }, '');
      pushedRef.current = true;
    }
  }, []);
  const exitChat = useCallback(() => {
    setShowChat(false);
    if (pushedRef.current) {
      pushedRef.current = false;
      // Pop our chat entry. The programmatic back fires popstate but draws NO
      // native animation; our track transition is the only slide.
      window.history.back();
    }
  }, []);

  const handleOpen = useCallback((session: OpenableSession) => {
    const next = { cwd: session.cwd, sessionId: session.sessionId, title: session.title };
    setActive(next);
    setShowChat(true);
    window.history.pushState({ [CHAT_MARKER]: next }, '');
    pushedRef.current = true;
  }, []);

  // Escape hatch: remember the choice so boot.js stops auto-redirecting, then
  // navigate to the desktop workspace.
  const handleUseDesktop = useCallback(() => {
    try { localStorage.setItem('cockpit-force-desktop', '1'); } catch { /* ignore */ }
    window.location.href = '/';
  }, []);

  // Deep-linked straight into a chat: seed a chat history entry above the boot
  // entry so the system Back returns to the list rather than unloading the page.
  useEffect(() => {
    if (initialCwd && initialSessionId) {
      window.history.pushState(
        { [CHAT_MARKER]: { cwd: initialCwd, sessionId: initialSessionId } },
        '',
      );
      pushedRef.current = true;
    }
  }, [initialCwd, initialSessionId]);

  // System Back/Forward button (and our own history.back()) → reconcile the page
  // to the history entry. Idempotent with enter/exitChat's optimistic updates.
  useEffect(() => {
    const onPop = (e: PopStateEvent) => {
      const s = (e.state as Record<string, OpenSession> | null)?.[CHAT_MARKER];
      if (s) {
        setActive({ cwd: s.cwd, sessionId: s.sessionId, title: s.title });
        setShowChat(true);
        pushedRef.current = true;
      } else {
        setShowChat(false);
        pushedRef.current = false;
      }
      setDragOffset(0);
    };
    window.addEventListener('popstate', onPop);
    return () => window.removeEventListener('popstate', onPop);
  }, []);

  // Track the page width (one page = container width) for px-accurate panning.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) setPageWidth(entry.contentRect.width);
    });
    setPageWidth(el.clientWidth);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Touch swipe — bound natively (passive:false) so touchmove.preventDefault()
  // actually suppresses the browser's horizontal back-gesture + scroll chaining.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    let startX = 0;
    let startY = 0;
    let dir: '?' | 'h' | 'v' = '?';

    const onStart = (e: TouchEvent) => {
      if (e.touches.length !== 1) return;
      startX = e.touches[0].clientX;
      startY = e.touches[0].clientY;
      dir = '?';
    };
    const onMove = (e: TouchEvent) => {
      if (dir === 'v' || e.touches.length !== 1) return;
      const dx = e.touches[0].clientX - startX;
      const dy = e.touches[0].clientY - startY;
      if (dir === '?') {
        if (Math.abs(dx) < 8 && Math.abs(dy) < 8) return;
        // Lock axis on first decisive move. Vertical → let the page scroll natively.
        dir = Math.abs(dx) > Math.abs(dy) ? 'h' : 'v';
        if (dir === 'h') setDragging(true);
        else return;
      }
      e.preventDefault();
      const W = pageWidthRef.current || el.clientWidth;
      const canChat = !!activeRef.current;
      let off = dx;
      if (!showChatRef.current) {
        // On the list: only a leftward drag toward the chat, and only if one exists.
        if (off > 0 || !canChat) off = 0;
        if (off < -W) off = -W;
      } else {
        // On the chat: only a rightward drag back toward the list.
        if (off < 0) off = 0;
        if (off > W) off = W;
      }
      setDragOffset(off);
    };
    const onEnd = (e: TouchEvent) => {
      if (dir !== 'h') { dir = '?'; return; }
      setDragging(false);
      setDragOffset(0);
      const W = pageWidthRef.current || el.clientWidth;
      const dx = (e.changedTouches[0]?.clientX ?? startX) - startX;
      const threshold = W * COMMIT_FRACTION;
      if (!showChatRef.current) {
        if (dx < -threshold && activeRef.current) enterChat();
      } else if (dx > threshold) {
        exitChat();
      }
      dir = '?';
    };

    el.addEventListener('touchstart', onStart, { passive: true });
    el.addEventListener('touchmove', onMove, { passive: false });
    el.addEventListener('touchend', onEnd, { passive: true });
    el.addEventListener('touchcancel', onEnd, { passive: true });
    return () => {
      el.removeEventListener('touchstart', onStart);
      el.removeEventListener('touchmove', onMove);
      el.removeEventListener('touchend', onEnd);
      el.removeEventListener('touchcancel', onEnd);
    };
  }, [enterChat, exitChat]);

  // Defensive scroll guard (belt to overflow-clip's suspenders): positioning is
  // transform-only, so any non-zero scrollLeft on the track container is pollution
  // (e.g. a scrollIntoView from chat content racing the 220ms page-slide used to
  // scroll the old overflow-hidden box and leave the chat half off-screen). With
  // overflow-clip the box is no longer a scroll container, but keep the reset in
  // case the overflow style ever regresses — same guard as SwipeablePages.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onScroll = () => {
      if (el.scrollLeft !== 0) el.scrollLeft = 0;
    };
    el.addEventListener('scroll', onScroll);
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  // Track transform: settle at page 0 (list) or -pageWidth (chat), plus live drag.
  // The container uses overflow-clip (NOT hidden) — a clipped box is not a scroll
  // container, so scrollIntoView can never inject a phantom scrollLeft that would
  // shift the track.
  const base = showChat ? -pageWidth : 0;
  const tx = base + dragOffset;

  return (
    <div
      ref={containerRef}
      className="relative h-[100dvh] w-full overflow-clip"
      style={{ overscrollBehaviorX: 'none', touchAction: 'pan-y' }}
    >
      <div
        className="flex h-full"
        style={{
          width: '200%',
          transform: pageWidth
            ? `translateX(${tx}px)`
            : showChat
              ? 'translateX(-50%)'
              : 'translateX(0)',
          transition: dragging ? 'none' : 'transform 220ms ease-out',
          willChange: 'transform',
        }}
      >
        <div className="h-full w-1/2 overflow-hidden">
          <MobileSessionList onOpen={handleOpen} onUseDesktop={handleUseDesktop} initialSessions={initialSessions} />
        </div>
        <div className="h-full w-1/2 overflow-hidden">
          {active && (
            <MobileChat
              key={`${active.cwd}-${active.sessionId}`}
              cwd={active.cwd}
              initialSessionId={active.sessionId}
              initialTitle={active.title}
              onBack={exitChat}
              isActive={showChat}
            />
          )}
        </div>
      </div>
    </div>
  );
}
