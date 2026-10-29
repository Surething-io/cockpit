'use client';

import { useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { MessageBubble } from './MessageBubble';
import { postSessionByPath } from './useChatHistory';
import { projectNameOf } from './SessionRowParts';
import type { ChatMessage } from './types';

/**
 * Right-hand pane of the list + preview boards (scheduled tasks, favorite
 * sessions): a read-only, live transcript of one chat session, read back through
 * /api/session-by-path exactly as SubagentTranscriptModal does for a subagent.
 *
 * The tail is all that is loaded (`limit: PREVIEW_TURNS` paginates backwards by
 * turn); a long-running session is not fetched in full for a peek.
 *
 * Mount with a `key` per session, so switching rows remounts this component —
 * there is no in-component "selection changed" reset to keep honest.
 */

const POLL_INTERVAL_MS = 5_000;
/** Turns fetched from the tail — the same first page the chat itself loads;
 *  enough to see what the session was last doing, cheap to poll. */
const PREVIEW_TURNS = 10;
/** How close to an end still counts as being at it, in px. */
const EDGE_SLACK = 40;

interface SessionTranscriptPreviewProps {
  cwd: string;
  sessionId: string;
  /** Second header line under the project name (task message, session title). */
  subtitle: string;
  /** Shown once loaded when the session has no messages (or cannot be read). */
  emptyText: string;
  onOpenSession: () => void;
}

export function SessionTranscriptPreview({ cwd, sessionId, subtitle, emptyText, onOpenSession }: SessionTranscriptPreviewProps) {
  const { t } = useTranslation();
  // null = still loading; [] = loaded and there is nothing to show
  const [messages, setMessages] = useState<ChatMessage[] | null>(null);
  const fingerprintRef = useRef<string | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    const fetchTranscript = async () => {
      const exit = await BrowserRuntime.runPromiseExit(
        postSessionByPath({
          cwd,
          sessionId,
          limit: PREVIEW_TURNS,
          ifFingerprint: fingerprintRef.current,
        })
      );
      if (cancelled) return;
      // A failed read resolves the loading state to "nothing"; a failed poll
      // after a good read keeps what is already on screen.
      if (exit._tag !== 'Success' || !exit.value) { setMessages((prev) => prev ?? []); return; }
      const data = exit.value as {
        notModified?: boolean;
        fingerprint?: string;
        messages?: ChatMessage[];
      };
      if (data.fingerprint) fingerprintRef.current = data.fingerprint;
      if (data.notModified) return;
      if (data.messages) setMessages(data.messages);
    };

    fetchTranscript();
    // The session can be running (a task firing, a favorite mid-turn) while the
    // board is open, so poll unconditionally — the fingerprint makes every
    // unchanged poll a no-op on both sides.
    const timer = setInterval(fetchTranscript, POLL_INTERVAL_MS);
    return () => { cancelled = true; clearInterval(timer); };
  }, [cwd, sessionId]);

  // Stick to bottom (the newest run) unless the user has scrolled up to read.
  // The same reading drives the "open session" button: it shows at either end of
  // the transcript — where the user is done reading, or has not started — and
  // gets out of the way everywhere in between.
  const bodyRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const stickToBottomRef = useRef(true);
  const [atEdge, setAtEdge] = useState(true);
  const syncScrollEdge = useCallback(() => {
    const el = bodyRef.current;
    if (!el) return;
    const bottom = el.scrollTop + el.clientHeight >= el.scrollHeight - EDGE_SLACK;
    stickToBottomRef.current = bottom;
    // A transcript shorter than the pane never scrolls, so it reads as both ends
    // at once — which is what we want: the button is there from the start.
    setAtEdge(bottom || el.scrollTop <= EDGE_SLACK);
  }, []);
  // Layout effect, not effect: new messages grow the content, which also wakes
  // the ResizeObserver below. Re-pinning to the bottom during commit means that
  // observer measures the corrected scrollTop and the button never blinks off
  // for a frame on every poll that brings a message.
  useLayoutEffect(() => {
    const el = bodyRef.current;
    if (el && stickToBottomRef.current) el.scrollTop = el.scrollHeight;
  }, [messages]);
  // Growing the content does not fire a scroll event, so expanding a tool call
  // would leave the button showing over a transcript that is no longer at its
  // end. Watch the content box, not the scroll container — the scroll container
  // keeps its size while what is inside it grows.
  useEffect(() => {
    const el = contentRef.current;
    if (!el) return;
    const observer = new ResizeObserver(syncScrollEdge);
    observer.observe(el);
    return () => observer.disconnect();
  }, [syncScrollEdge, messages]);

  return (
    // flex-1 (not just h-full): the parent is a flex ROW, so without it the pane
    // shrinks to its content width and the transcript wraps into a sliver.
    <div className="flex-1 flex flex-col h-full min-w-0">
      {/* Header — identity only. Navigating to the session sits at the end of the
          transcript instead, where the user has just finished reading. */}
      <div className="flex items-center gap-2 px-4 py-2.5 border-b border-border flex-shrink-0">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-medium text-foreground truncate" data-tooltip={cwd}>
            {projectNameOf(cwd)}
          </div>
          <div className="text-[11px] text-muted-foreground truncate" data-tooltip={subtitle}>
            {subtitle}
          </div>
        </div>
      </div>

      {/* Transcript — keep the scroll surface full-width, but use the same
          gutter and centred conversation column as MessageList. User/assistant
          alignment is meaningful only inside that shared column; letting the
          turns use the whole preview pane pushes them to opposite screen edges. */}
      <div className="relative flex-1 min-h-0 flex">
        <div ref={bodyRef} onScroll={syncScrollEdge} className="flex-1 overflow-y-auto px-8 py-4">
          {messages === null || messages.length === 0 ? (
            <div className="text-xs text-muted-foreground text-center py-6">
              {messages === null ? t('common.loading') : emptyText}
            </div>
          ) : (
            // `disableOverlays` drops only the controls that would open a window on
            // top of the app (diff viewer, file/image previews, subagent + workflow
            // transcripts, tool input/result viewers) — each of those is a Portal on
            // <body> at z-50, i.e. behind this board (z-[70]). Everything in-place
            // stays live: expand/collapse a tool call, copy a path, select text.
            //
            // Links are killed separately, and for a different reason: this pane
            // passes no `onOpenFileLink`, so MarkdownRenderer leaves the anchor to
            // the browser and a click would navigate the whole Cockpit window away.
            <div
              ref={contentRef}
              className="mx-auto w-full max-w-[var(--chat-column)] [&_a]:pointer-events-none"
            >
              {messages.map((m) => (
                <MessageBubble key={m.id} message={m} cwd={cwd} disableOverlays />
              ))}
            </div>
          )}
        </div>

        {/* Pinned to the pane's bottom edge rather than sitting in the flow: in
            the flow it would ride up whenever the content is shorter than the
            viewport. Fades out as soon as the view leaves either end — scrolling
            into the middle, or expanding a tool call, which pushes the end away
            without ever firing a scroll event. `pointer-events` follows the
            opacity, or the invisible button would still swallow clicks meant for
            the message underneath. */}
        <div className="pointer-events-none absolute inset-x-0 bottom-0 flex justify-center pb-4">
          <button
            onClick={onOpenSession}
            className={`flex items-center gap-1.5 px-5 py-2.5 rounded-full bg-brand text-white text-sm font-medium shadow-lv3 hover:bg-brand/90 transition-opacity ${
              atEdge ? 'opacity-100 pointer-events-auto' : 'opacity-0'
            }`}
            title={t('scheduledTasks.openSession')}
          >
            <span>{t('scheduledTasks.openSession')}</span>
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M14 5l7 7-7 7M3 12h18" />
            </svg>
          </button>
        </div>
      </div>
    </div>
  );
}
