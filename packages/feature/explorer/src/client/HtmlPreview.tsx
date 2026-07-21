'use client';

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ToolbarRenderer,
  type ToolbarData,
  AddCommentInput,
  SendToAIInput,
  useAIBridge,
} from '@cockpit/shared-ui';
import { injectBashSdk, resolveBashCwd, toLocalAppUrl, canResolveAbsolute } from '@cockpit/shared-utils';
import {
  useComments,
  fetchAllCommentsWithCode,
  clearAllComments,
  buildAIMessage,
  type CodeReference,
} from '@cockpit/feature-comments';

interface HtmlPreviewProps {
  /** Raw HTML source. Optional: only used by the srcDoc fallback (relative
   *  filePath + no cwd). URL mode (absolute path) serves off disk and ignores it. */
  content?: string;
  /** File path — used as a React key so the iframe reloads on file switch */
  filePath: string;
  /** Project root. When provided, enables the selection toolbar
   *  (add comment / send to AI / search) over the rendered page.
   *  Omit for plain preview (e.g. commit detail panel). */
  cwd?: string;
  /** Hands the selected text to project-wide content search. The search
   *  button is only rendered when this is provided (host convention). */
  onContentSearch?: (query: string) => void;
}

/**
 * In-place HTML preview in a sandboxed iframe. Mirrors the markdown in-place
 * preview UX (the host toolbar owns the Preview toggle); only the rendered
 * content differs.
 *
 * Renders via `src="/apps/local/<abs>"` (a real same-origin URL served off
 * disk), so the page behaves like a static site — relative sibling js/css,
 * images and CDN refs all resolve, and multi-file pages work. Only when no
 * absolute path is derivable (relative filePath + no cwd) does it fall back to
 * inline `srcDoc` (single-file only).
 *
 * SECURITY MODEL: rendering an interactive preview is ALWAYS an explicit user
 * gesture (clicking a "Preview" button/toggle, opening a modal, selecting a file
 * after enabling HTML preview). That gesture IS the trust decision, so every
 * preview gets the bash SDK + `allow-same-origin`. The single guard lives at the
 * entry points, not here: nothing auto-previews HTML — the Explorer file browser
 * shows source for .html until the user clicks Preview. (Purely-local app; the
 * accepted trade-off is that previewing any local .html can run host commands.)
 *
 * Selection toolbar: needs `allow-same-origin` (always granted now), so the host
 * can listen inside the iframe document and read its selection. Rendered DOM has no
 * mapping back to source lines, so comments are anchored by the selected-text
 * snapshot (range 0-0) — same model as chat-bubble comments: no in-preview
 * markers, the comment carries the quoted text and shows up in the comments
 * list modal. If the previewed page's own JS swallows mouse events or clears
 * the selection, the toolbar simply won't appear on that page (accepted edge).
 */
export function HtmlPreview({ content, filePath, cwd, onContentSearch }: HtmlPreviewProps) {
  const aiBridge = useAIBridge();
  // Previewing is always a user gesture → always trusted. Selection toolbar just
  // needs a project cwd to anchor comments against.
  const commentsEnabled = !!cwd;

  // How to render the page:
  //  - PRIMARY (mode 'url'): serve the file through /apps/local so it behaves
  //    like a real static site — relative sibling js/css, images and CDN refs
  //    all resolve (a srcDoc document has no base URL and can't). The window.
  //    cockpit bash SDK is injected server-side by the /apps route.
  //  - FALLBACK (mode 'srcdoc'): only when no absolute path is derivable
  //    (relative filePath + no cwd). Inline the content with the SDK injected
  //    client-side; single-file only, but keeps preview working.
  const renderSource = useMemo((): { mode: 'url'; url: string } | { mode: 'srcdoc'; html: string } => {
    if (canResolveAbsolute(filePath, cwd)) {
      return { mode: 'url', url: toLocalAppUrl(filePath, cwd) };
    }
    if (typeof window === 'undefined') return { mode: 'srcdoc', html: content ?? '' };
    const dir = resolveBashCwd(filePath, cwd);
    const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${wsProto}//${window.location.host}/ws/bash?cwd=${encodeURIComponent(dir)}`;
    return { mode: 'srcdoc', html: injectBashSdk(content ?? '', { cwd: dir, wsUrl }) };
  }, [content, filePath, cwd]);
  const { addComment, refresh: refreshComments } = useComments({ cwd: cwd || '', filePath });

  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const iframeRef = useRef<HTMLIFrameElement | null>(null);
  const floatingToolbarRef = useRef<ToolbarData | null>(null);
  const bumpToolbarRef = useRef<() => void>(() => {});

  const [commentInput, setCommentInput] = useState<{ x: number; y: number; text: string } | null>(null);
  const [sendAIInput, setSendAIInput] = useState<{ x: number; y: number; text: string } | null>(null);

  // The iframe listeners are attached once per document load, so they read
  // open-card state through a ref instead of a (stale) closure.
  const cardOpenRef = useRef(false);
  useEffect(() => {
    cardOpenRef.current = !!(commentInput || sendAIInput);
  }, [commentInput, sendAIInput]);

  const clearToolbar = useCallback(() => {
    if (floatingToolbarRef.current) {
      floatingToolbarRef.current = null;
      bumpToolbarRef.current();
    }
  }, []);

  // Attach selection listeners to the iframe document. Re-runs on every
  // load (srcDoc change / file switch replaces the document; listeners on
  // the old document die with it).
  const handleIframeLoad = useCallback(() => {
    if (!commentsEnabled) return;
    const iframe = iframeRef.current;
    const doc = iframe?.contentDocument;
    if (!iframe || !doc) return;

    const handleMouseUp = (e: MouseEvent) => {
      if (cardOpenRef.current) return;
      const sel = iframe.contentWindow?.getSelection();
      const text = sel && !sel.isCollapsed ? sel.toString().trim() : '';
      if (!text) {
        clearToolbar();
        return;
      }
      // Event coords are in iframe viewport space → shift by the iframe's
      // position to get host client coords (what the toolbar expects).
      const rect = iframe.getBoundingClientRect();
      floatingToolbarRef.current = {
        x: rect.left + e.clientX,
        y: rect.top + e.clientY,
        range: { start: 0, end: 0 },
        selectedText: text,
        lineSnapshot: text,
      };
      bumpToolbarRef.current();
    };
    // The toolbar and input cards live in the host overlay — a mousedown
    // inside the iframe can never hit them, so it's always safe to dismiss
    // both here. (The cards' own click-outside handler listens on the HOST
    // document; clicks inside the iframe don't reach it, so without this
    // the cards would ignore clicks on the previewed page.)
    const handleMouseDown = () => {
      clearToolbar();
      setCommentInput(null);
      setSendAIInput(null);
    };
    // Iframe-internal scrolling invalidates the stored coords.
    const handleScroll = () => clearToolbar();

    doc.addEventListener('mouseup', handleMouseUp);
    doc.addEventListener('mousedown', handleMouseDown);
    doc.addEventListener('scroll', handleScroll, { capture: true, passive: true });
  }, [commentsEnabled, clearToolbar]);

  // ---- Toolbar actions ----

  const handleAddComment = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb) return;
    setCommentInput({ x: tb.x, y: tb.y, text: tb.selectedText });
    clearToolbar();
    iframeRef.current?.contentWindow?.getSelection()?.removeAllRanges();
  }, [clearToolbar]);

  const handleToolbarSendToAI = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb) return;
    setSendAIInput({ x: tb.x, y: tb.y, text: tb.selectedText });
    clearToolbar();
    iframeRef.current?.contentWindow?.getSelection()?.removeAllRanges();
  }, [clearToolbar]);

  const handleSearch = useCallback(() => {
    const tb = floatingToolbarRef.current;
    if (!tb || !onContentSearch) return;
    const query = tb.selectedText.trim();
    clearToolbar();
    iframeRef.current?.contentWindow?.getSelection()?.removeAllRanges();
    if (query) onContentSearch(query);
  }, [onContentSearch, clearToolbar]);

  // ---- Submit paths ----

  // Comments anchor by selected-text snapshot: range 0-0 under the real
  // file path (fetchAllCommentsWithCode uses selectedText directly).
  const handleCommentSubmit = useCallback(async (commentContent: string) => {
    if (!commentInput) return;
    await addComment(0, 0, commentContent, commentInput.text);
    setCommentInput(null);
  }, [commentInput, addComment]);

  // Shared send-to-AI orchestration for both entries (standalone SendToAI
  // card / comment card button) — all historical comments + the current
  // selection go out as one message, then the comment stack is cleared.
  const sendSelectionToAI = useCallback(async (selectedText: string, question: string) => {
    if (!aiBridge || !cwd) return;
    try {
      const allComments = await fetchAllCommentsWithCode(cwd);
      const references: CodeReference[] = allComments.map((c) => ({
        filePath: c.filePath,
        startLine: c.startLine,
        endLine: c.endLine,
        codeContent: c.codeContent,
        note: c.content || undefined,
      }));
      references.push({
        filePath,
        startLine: 0,
        endLine: 0,
        codeContent: selectedText,
      });
      const message = buildAIMessage(references, question);
      aiBridge.sendMessage(message);
      await clearAllComments(cwd);
      refreshComments();
    } catch (err) {
      console.error('[HtmlPreview] send to AI failed:', err);
    }
  }, [aiBridge, cwd, filePath, refreshComments]);

  // Both cards close themselves on submit — deliberately NO trailing state
  // reset after the async send (a late set(null) could clobber a card the
  // user opened in the meantime).
  const handleSendAISubmit = useCallback((question: string) => {
    if (!sendAIInput) return;
    void sendSelectionToAI(sendAIInput.text, question);
  }, [sendAIInput, sendSelectionToAI]);

  const handleCommentSendToAI = useCallback((question: string) => {
    if (!commentInput) return;
    void sendSelectionToAI(commentInput.text, question);
  }, [commentInput, sendSelectionToAI]);

  return (
    <div ref={setContainer} className="relative h-full w-full bg-white">
      <iframe
        ref={iframeRef}
        key={filePath}
        {...(renderSource.mode === 'url'
          ? { src: renderSource.url }
          : { srcDoc: renderSource.html })}
        title={filePath}
        // Previewing is a user gesture → trusted: allow-same-origin gives the
        // SDK its same-origin /ws/bash and lets the host read the selection.
        sandbox="allow-scripts allow-same-origin"
        className="h-full w-full border-0"
        onLoad={handleIframeLoad}
      />

      {/* Selection toolbar + input cards, overlaid on the host side */}
      {commentsEnabled && container && (
        <>
          <ToolbarRenderer
            floatingToolbarRef={floatingToolbarRef}
            bumpRef={bumpToolbarRef}
            container={container}
            onAddComment={handleAddComment}
            onSendToAI={handleToolbarSendToAI}
            onSearch={onContentSearch ? handleSearch : undefined}
            isChatLoading={aiBridge?.isLoading}
          />
          {commentInput && (
            <AddCommentInput
              x={commentInput.x}
              y={commentInput.y}
              range={{ start: 0, end: 0 }}
              filePath={filePath}
              lineSnapshot={commentInput.text}
              container={container}
              onSubmit={handleCommentSubmit}
              onSendToAI={aiBridge ? handleCommentSendToAI : undefined}
              onClose={() => setCommentInput(null)}
              isChatLoading={aiBridge?.isLoading}
            />
          )}
          {sendAIInput && (
            <SendToAIInput
              x={sendAIInput.x}
              y={sendAIInput.y}
              range={{ start: 0, end: 0 }}
              filePath={filePath}
              lineSnapshot={sendAIInput.text}
              container={container}
              onSubmit={handleSendAISubmit}
              onClose={() => setSendAIInput(null)}
              isChatLoading={aiBridge?.isLoading}
            />
          )}
        </>
      )}
    </div>
  );
}

export default HtmlPreview;
