'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';

// ============================================
// Quick replies
// ============================================

/** Which of the two toolbar actions a quick reply was picked under. */
export type QuickReplyTarget = 'comment' | 'ai';

/**
 * Quick-reply phrases, pre-grouped into display rows:
 * options / stance / follow-up / execute.
 *
 * Grouping is carried by the row breaks alone — no headings. Headings would
 * roughly double the panel's height and add four more strings to translate,
 * for information the layout already conveys.
 *
 * Each entry is ONE i18n key doing double duty: the button label AND the text
 * that is sent. Every phrase fits a button in both zh and en, so splitting into
 * label/text pairs would duplicate every phrase in every locale, plus leave a
 * standing invitation to update only one half — the exact trap
 * `explain.action` vs `explain.selectionMessage` already sets.
 *
 * Because the value is sent verbatim, keep each one a complete utterance:
 * abbreviations and bare nouns read fine on a button but reach the model as a
 * fragment ("All recs", "Example").
 */
const QUICK_REPLY_ROWS: readonly (readonly string[])[] = [
  ['quickReply.optionA', 'quickReply.optionB', 'quickReply.optionC'],
  ['quickReply.allRecommended', 'quickReply.thisOne', 'quickReply.notThis'],
  ['quickReply.why', 'quickReply.elaborate', 'quickReply.example'],
  ['quickReply.start', 'quickReply.continue', 'quickReply.ok'],
];

/** Grace period before a hover-out closes the panel. Without it the pointer
 *  cannot cross the gap between the trigger button and the panel below it. */
const HOVER_CLOSE_DELAY_MS = 150;

function QuickReplyPanel({
  placeAbove,
  onHeight,
  onPick,
  onMouseEnter,
  onMouseLeave,
}: {
  placeAbove: boolean;
  onHeight: (height: number) => void;
  onPick: (text: string) => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  // Report height up so the toolbar can decide which side to open on. The
  // rows are fixed, so this settles on the first hover and is reused after.
  useEffect(() => {
    if (panelRef.current) onHeight(panelRef.current.getBoundingClientRect().height);
  }, [onHeight]);

  return (
    // Rendered INSIDE .floating-toolbar on purpose: hosts clear the selection
    // on mousedown unless the target is `closest('.floating-toolbar')`, so a
    // panel mounted as a sibling would wipe the selection it acts on.
    <div
      ref={panelRef}
      className={`absolute ${placeAbove ? 'bottom-full mb-1' : 'top-full mt-1'} left-0 z-[201] flex flex-col gap-1 bg-card border border-border rounded-lg shadow-xl p-1.5`}
      onMouseEnter={onMouseEnter}
      onMouseLeave={onMouseLeave}
    >
      {QUICK_REPLY_ROWS.map((row, rowIndex) => (
        <div key={rowIndex} className="flex items-center gap-1">
          {row.map((key) => (
            <button
              key={key}
              className="px-2 py-1 text-xs whitespace-nowrap border border-border text-foreground rounded hover:bg-accent transition-colors"
              onClick={() => onPick(t(key))}
            >
              {t(key)}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

// ============================================
// Floating Toolbar (portal version with container-relative positioning)
// ============================================

interface FloatingToolbarProps {
  x: number;
  y: number;
  visible: boolean;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  onSearch?: () => void;
  /** One-click "explain this selection" — sends straight away, with no
   *  question card in between. Hosts that wire it must send *only* the
   *  selection (see `sendReferenceToAI`); the card-based onSendToAI flow
   *  additionally submits and clears the whole comment stack, which is not
   *  something a single click should do. */
  onExplain?: () => void;
  /** Opt-in: hovering "add comment" / "send to AI" reveals a panel of canned
   *  one-tap replies. Hosts that leave it undefined render no panel — the
   *  phrases answer a chat question, which is meaningless over a code selection
   *  in the explorer surfaces that share this component. */
  onQuickReply?: (target: QuickReplyTarget, text: string) => void;
  isChatLoading?: boolean;
}

export function FloatingToolbar({ x, y, visible, container, onAddComment, onSendToAI, onSearch, onExplain, onQuickReply, isChatLoading }: FloatingToolbarProps) {
  const { t } = useTranslation();
  const toolbarRef = useRef<HTMLDivElement>(null);
  const [selfSize, setSelfSize] = useState({ w: 0, h: 0 });
  const [panelHeight, setPanelHeight] = useState(0);
  const [hovered, setHovered] = useState<QuickReplyTarget | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Measure to clamp against the container's edges. Runs after every render;
  // the equality guard is what stops it looping on its own setState.
  // useLayoutEffect, not useEffect: the clamp depends on this measurement, so
  // measuring after paint would show one frame at the unclamped position and
  // then snap. Ancestors can also toggle display:none (inactive panel/tab),
  // which zeroes the rect without re-rendering us — the next render, i.e. the
  // one that shows the toolbar, is what re-measures.
  useLayoutEffect(() => {
    const el = toolbarRef.current;
    if (!el) return;
    const { width, height } = el.getBoundingClientRect();
    setSelfSize((prev) => (prev.w === width && prev.h === height ? prev : { w: width, h: height }));
  });

  const handlePanelHeight = useCallback((h: number) => {
    setPanelHeight((prev) => (prev === h ? prev : h));
  }, []);

  // A toolbar that hid (or moved to a new selection) must not come back with a
  // panel still hanging open from the previous one.
  useEffect(() => {
    if (!visible) setHovered(null);
  }, [visible]);

  const cancelClose = useCallback(() => {
    if (closeTimerRef.current) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const openPanel = useCallback((target: QuickReplyTarget) => {
    cancelClose();
    setHovered(target);
  }, [cancelClose]);

  const scheduleClose = useCallback(() => {
    cancelClose();
    closeTimerRef.current = setTimeout(() => setHovered(null), HOVER_CLOSE_DELAY_MS);
  }, [cancelClose]);

  useEffect(() => cancelClose, [cancelClose]);

  const containerRect = container.getBoundingClientRect();
  const relX = x - containerRect.left;
  const relY = y - containerRect.top;

  // Position above-right of cursor: offset 40px up, 8px to the right, then
  // pulled back so the toolbar can't run past the container's right edge.
  // (The quick-reply panel is narrower than the toolbar, so clamping the
  // toolbar keeps the panel in bounds too.)
  const toolbarTop = Math.max(0, relY - 40);
  const toolbarLeft = Math.max(0, Math.min(relX + 8, containerRect.width - selfSize.w - 8));

  // Open the panel upward when there isn't room below. Selections near the
  // bottom of a chat log are the common case, not the edge case — the newest
  // message is what people quote — so a fixed downward panel would be cut off
  // by the container exactly when it is most used.
  const placeAbove =
    panelHeight > 0 && toolbarTop + selfSize.h + 8 + panelHeight > containerRect.height;

  const renderQuickReplies = (target: QuickReplyTarget) =>
    onQuickReply && hovered === target ? (
      <QuickReplyPanel
        placeAbove={placeAbove}
        onHeight={handlePanelHeight}
        onPick={(text) => {
          setHovered(null);
          onQuickReply(target, text);
        }}
        onMouseEnter={cancelClose}
        onMouseLeave={scheduleClose}
      />
    ) : null;

  return (
    <div
      ref={toolbarRef}
      className="floating-toolbar absolute z-[200] flex items-center gap-1.5 bg-card border border-border rounded-lg shadow-xl p-1.5"
      style={{
        left: toolbarLeft,
        top: toolbarTop,
        visibility: visible ? 'visible' : 'hidden',
        pointerEvents: visible ? 'auto' : 'none',
      }}
    >
      {/* Hover lives on the wrapper, not the button: a disabled <button> stops
          dispatching mouse events in most browsers, which would make the panel
          unreachable exactly while `isChatLoading` gates the AI action. */}
      <div className="relative" onMouseEnter={() => openPanel('comment')} onMouseLeave={scheduleClose}>
        <button
          className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors"
          onClick={onAddComment}
        >
          {t('floatingToolbar.addComment')}
        </button>
        {renderQuickReplies('comment')}
      </div>
      <div
        className="relative"
        onMouseEnter={() => { if (!isChatLoading) openPanel('ai'); }}
        onMouseLeave={scheduleClose}
      >
        <button
          className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onSendToAI}
          disabled={isChatLoading}
          title={isChatLoading ? t('comments.aiResponding') : t('floatingToolbar.sendToAI')}
        >
          {t('floatingToolbar.sendToAI')}
        </button>
        {renderQuickReplies('ai')}
      </div>
      {onExplain && (
        <button
          className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          onClick={onExplain}
          disabled={isChatLoading}
          title={isChatLoading ? t('comments.aiResponding') : t('explain.action')}
        >
          {t('explain.action')}
        </button>
      )}
      {onSearch && (
        <button
          className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors"
          onClick={onSearch}
        >
          {t('floatingToolbar.search')}
        </button>
      )}
    </div>
  );
}

// ============================================
// ToolbarRenderer - isolated state to avoid parent component re-renders
// Only the toolbar's own show/hide triggers a re-render of this component.
// ============================================

export interface ToolbarData {
  x: number;
  y: number;
  range: { start: number; end: number };
  /** The literal user selection — `window.getSelection().toString()`.
   *  Used by:
   *  - Search action (so the search query equals what the user sees highlighted)
   *  - `addComment(..., selectedText)` DB snapshot
   *  - SendToAI reference quoting (when the prompt wants "the exact phrase the user picked"). */
  selectedText: string;
  /** The selection's range expanded to whole lines / source blocks of the
   *  underlying data:
   *  - Code views: `lines.slice(start-1, end).join('\n')`
   *  - Diff views: matching `diffLines[i].content` joined
   *  - Markdown preview: `sourceLines.slice(start-1, end).join('\n')`
   *  Used by the AddCommentInput preview card and by its SendToAI action
   *  as `CodeReference.codeContent` (where "full lines" gives AI better
   *  context than the truncated literal selection). */
  lineSnapshot: string;
}

interface ToolbarRendererProps {
  floatingToolbarRef: React.RefObject<ToolbarData | null>;
  bumpRef: React.MutableRefObject<() => void>;
  container: HTMLElement;
  onAddComment: () => void;
  onSendToAI: () => void;
  onSearch?: () => void;
  onExplain?: () => void;
  onQuickReply?: (target: QuickReplyTarget, text: string) => void;
  isChatLoading?: boolean;
}

function ToolbarRendererInner({ floatingToolbarRef, bumpRef, container, onAddComment, onSendToAI, onSearch, onExplain, onQuickReply, isChatLoading }: ToolbarRendererProps) {
  const [version, forceRender] = useState(0);

  // Allow parent to trigger a re-render of this component via bumpRef
  useEffect(() => {
    bumpRef.current = () => forceRender(v => v + 1);
  }, [bumpRef]);

   
  const toolbar = useMemo(() => floatingToolbarRef.current, [version]);

  return (
    <FloatingToolbar
      x={toolbar?.x ?? 0}
      y={toolbar?.y ?? 0}
      visible={!!toolbar}
      container={container}
      onAddComment={onAddComment}
      onSendToAI={onSendToAI}
      onSearch={onSearch}
      onExplain={onExplain}
      onQuickReply={onQuickReply}
      isChatLoading={isChatLoading}
    />
  );
}
export const ToolbarRenderer = memo(ToolbarRendererInner);
