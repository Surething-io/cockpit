'use client';

import React, { useState, useEffect, useLayoutEffect, useRef, useCallback, useMemo, memo } from 'react';
import { useTranslation } from 'react-i18next';

// ============================================
// Quick replies
// ============================================

/** Which of the two toolbar actions a quick reply was picked under. */
export type QuickReplyTarget = 'comment' | 'ai';

/**
 * Default quick-reply phrases, pre-grouped into display rows:
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
 *
 * Exported so a host that lets the user customize the phrases can seed its
 * editor with — and fall back to — exactly what the panel would have shown.
 * Hosts resolve the keys with their own `t`; keeping the export as keys rather
 * than resolved strings is what makes the untouched panel follow a language
 * switch.
 */
export const DEFAULT_QUICK_REPLY_KEYS: readonly (readonly string[])[] = [
  ['quickReply.optionA', 'quickReply.optionB', 'quickReply.optionC', 'quickReply.optionD'],
  ['quickReply.allRecommended', 'quickReply.thisOne', 'quickReply.notThis'],
  ['quickReply.why', 'quickReply.elaborate', 'quickReply.example'],
  ['quickReply.start', 'quickReply.continue', 'quickReply.ok', 'quickReply.done'],
];

/** Rows of ready-to-send phrases — already resolved, no i18n keys. */
export type QuickReplyRows = readonly (readonly string[])[];

/** Grace period before a hover-out closes the panel. Without it the pointer
 *  cannot cross the gap between the trigger button and the panel below it. */
const HOVER_CLOSE_DELAY_MS = 150;

function QuickReplyPanel({
  rows,
  placeAbove,
  onHeight,
  onPick,
  onEdit,
  onMouseEnter,
  onMouseLeave,
}: {
  rows: QuickReplyRows;
  placeAbove: boolean;
  onHeight: (height: number) => void;
  onPick: (text: string) => void;
  onEdit?: () => void;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
}) {
  const { t } = useTranslation();
  const panelRef = useRef<HTMLDivElement>(null);

  // Report height up so the toolbar can decide which side to open on.
  // `rows` is in the deps because a custom phrase set can have a different
  // number of rows than the default — without it, an edit that adds rows would
  // keep opening the panel against a stale (shorter) height and get clipped.
  useEffect(() => {
    if (panelRef.current) onHeight(panelRef.current.getBoundingClientRect().height);
  }, [onHeight, rows]);

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
      {onEdit && (
        // Absolutely positioned so it costs no height — the panel's open
        // direction is computed from that height, and a header row would push
        // the panel taller for an affordance used once in a blue moon.
        <button
          className="absolute top-0.5 right-0.5 p-1 text-muted-foreground hover:text-brand transition-colors"
          onClick={onEdit}
          title={t('quickReply.edit')}
          aria-label={t('quickReply.edit')}
        >
          <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path
              strokeLinecap="round"
              strokeLinejoin="round"
              strokeWidth={2}
              d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z"
            />
          </svg>
        </button>
      )}
      {rows.map((row, rowIndex) => (
        // Only the FIRST row reserves space for the pencil. The panel is as
        // wide as its widest row, so if some later row is wider this padding
        // changes nothing; if the first row is the widest, it grows the panel
        // just enough that no button ends up under the icon.
        <div
          key={rowIndex}
          className={`flex items-center gap-1${onEdit && rowIndex === 0 ? ' pr-5' : ''}`}
        >
          {row.map((phrase, i) => (
            <button
              // Custom phrase sets can legitimately repeat a phrase across
              // rows, so the phrase alone is not a stable key.
              key={`${rowIndex}:${i}:${phrase}`}
              className="px-2 py-1 text-xs whitespace-nowrap border border-border text-foreground rounded hover:border-brand hover:bg-accent transition-colors"
              onClick={() => onPick(phrase)}
            >
              {phrase}
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
  /** User-customized phrases. Undefined = show the built-in i18n defaults,
   *  which keep following the language switch. */
  quickReplyRows?: QuickReplyRows;
  /** Opt-in: renders a pencil in the panel's top-right corner. The host owns
   *  the editor dialog — it must live OUTSIDE this component, which unmounts
   *  as soon as the selection it belongs to is cleared (a dialog rendered in
   *  here would vanish on the first click into its own textarea). */
  onEditQuickReplies?: () => void;
  isChatLoading?: boolean;
}

export function FloatingToolbar({ x, y, visible, container, onAddComment, onSendToAI, onSearch, onExplain, onQuickReply, quickReplyRows, onEditQuickReplies, isChatLoading }: FloatingToolbarProps) {
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

  // Falls back to the built-in phrases when the host has no custom set. Memoized
  // because it is a fresh array every render otherwise, which would re-fire the
  // panel's height-report effect on every parent render.
  const resolvedRows = useMemo(
    () => quickReplyRows ?? DEFAULT_QUICK_REPLY_KEYS.map((row) => row.map((key) => t(key))),
    [quickReplyRows, t]
  );

  const renderQuickReplies = (target: QuickReplyTarget) =>
    onQuickReply && hovered === target ? (
      <QuickReplyPanel
        rows={resolvedRows}
        onEdit={onEditQuickReplies}
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
          title={isChatLoading ? t('comments.aiResponding') : undefined}
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
          title={isChatLoading ? t('comments.aiResponding') : undefined}
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
  quickReplyRows?: QuickReplyRows;
  onEditQuickReplies?: () => void;
  isChatLoading?: boolean;
}

function ToolbarRendererInner({ floatingToolbarRef, bumpRef, container, onAddComment, onSendToAI, onSearch, onExplain, onQuickReply, quickReplyRows, onEditQuickReplies, isChatLoading }: ToolbarRendererProps) {
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
      quickReplyRows={quickReplyRows}
      onEditQuickReplies={onEditQuickReplies}
      isChatLoading={isChatLoading}
    />
  );
}
export const ToolbarRenderer = memo(ToolbarRendererInner);
