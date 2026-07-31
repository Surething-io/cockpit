'use client';

/**
 * useDiffComments — the shared comment / selection-toolbar / send-to-AI /
 * content-search plumbing for the diff views.
 *
 * Extracted from `DiffView` (split) so `DiffUnifiedView` (single-column) can
 * reuse the EXACT same behaviour instead of a hand-copied second implementation.
 * Keeping one source of truth is what prevents the two views from drifting —
 * the drift that had left the unified view without comments / preview / search
 * in the first place.
 *
 * Anchoring is entirely by NEW-FILE line number (`data-new-line`): only added /
 * unchanged rows carry the attribute, so a selection on the old (removed) side
 * never resolves to a range and never opens the toolbar. That convention is
 * layout-agnostic, which is why the split view's right column and the unified
 * view's single column can share this hook unchanged — each just passes its own
 * scroll container as `containerEl`.
 */

import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { createPortal } from 'react-dom';
import { useComments, type CodeComment } from '@cockpit/feature-comments';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, sendReferenceToAI, type CodeReference } from '@cockpit/feature-comments';
import i18n from '@cockpit/shared-i18n';
import { useMenuContainer, useAIBridge, AddCommentInput, SendToAIInput, ToolbarRenderer } from '@cockpit/shared-ui';
import { ViewCommentCard } from './index';
import { useSelectionToolbar } from './useSelectionToolbar';
import type { DiffLine } from './index';

interface UseDiffCommentsParams {
  cwd?: string;
  enableComments?: boolean;
  filePath: string;
  /** The full diff — walked to build the line snapshot of a selection. */
  diffLines: DiffLine[];
  /**
   * The scrollable element that hosts the new-file line rows (each tagged
   * `data-new-line`). Split view passes its right (new) column; unified passes
   * its single scroll container. Selections outside it never open the toolbar.
   * Pass an ELEMENT (via a state mirror), not a ref — see useSelectionToolbar.
   */
  containerEl: HTMLElement | null;
  /** Selected text → project-wide search. Absent → no Search toolbar button. */
  onContentSearch?: (query: string) => void;
}

interface SelectionInput {
  x: number;
  y: number;
  range: { start: number; end: number };
  selectedText: string;
  lineSnapshot: string;
}

export interface UseDiffCommentsResult {
  /** `enableComments && !!cwd` — gate the gutter bubble / toolbar on this. */
  commentsEnabled: boolean;
  /** New-file line numbers that have at least one comment. */
  linesWithComments: Set<number>;
  /** Comments grouped by their end line (the line the bubble renders on). */
  commentsByEndLine: Map<number, CodeComment[]>;
  handleCommentBubbleClick: (comment: CodeComment, e: React.MouseEvent) => void;
  /** Active add-comment / send-to-AI selection ranges — tint the covered rows
   *  while a card is open. Null when no card is open. */
  addCommentRange: { start: number; end: number } | null;
  sendToAIRange: { start: number; end: number } | null;
  /** Floating toolbar + comment / AI cards, portaled to the menu container.
   *  Render this node once anywhere in the consuming component's tree. */
  commentPortal: React.ReactNode;
}

export function useDiffComments({
  cwd,
  enableComments = false,
  filePath,
  diffLines,
  containerEl,
  onContentSearch,
}: UseDiffCommentsParams): UseDiffCommentsResult {
  // Menu container for portal mounting (keeps floating elements within second screen)
  const menuContainer = useMenuContainer();
  // Chat context for "Send to AI" feature
  const aiBridge = useAIBridge();

  const commentsEnabled = enableComments && !!cwd;
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({
    cwd: cwd || '',
    filePath,
  });

  const [viewingComment, setViewingComment] = useState<{
    comment: CodeComment;
    x: number;
    y: number;
  } | null>(null);

  const { toolbarRef: floatingToolbarRef, bumpRef: bumpToolbarRef, clearToolbar } = useSelectionToolbar({
    enabled: commentsEnabled,
    container: containerEl,
    resolveLineRange: (node) => {
      if (!document.contains(node)) return null;
      const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
      const lineRow = el?.closest('[data-new-line]');
      if (!lineRow) return null;
      const n = parseInt(lineRow.getAttribute('data-new-line') || '0', 10);
      if (!Number.isFinite(n) || n <= 0) return null;
      return { start: n, end: n };
    },
    // Walk diffLines and pull `content` for rows that appear in the new file
    // (unchanged + added). Re-read via a ref by the hook so it never staled.
    buildLineSnapshot: ({ start, end }) => {
      const out: string[] = [];
      let n = 0;
      for (const dl of diffLines) {
        if (dl.type === 'unchanged' || dl.type === 'added') {
          n++;
          if (n >= start && n <= end) out.push(dl.content);
        }
      }
      return out.join('\n');
    },
  });

  const [addCommentInput, setAddCommentInput] = useState<SelectionInput | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<SelectionInput | null>(null);

  // Track mount state for Portal
  const [isMounted, setIsMounted] = useState(false);
  useEffect(() => {
    setIsMounted(true);
  }, []);

  // Lines with comments (based on new file line numbers)
  const linesWithComments = useMemo(() => {
    const set = new Set<number>();
    for (const comment of comments) {
      for (let i = comment.startLine; i <= comment.endLine; i++) {
        set.add(i);
      }
    }
    return set;
  }, [comments]);

  // Comments grouped by end line
  const commentsByEndLine = useMemo(() => {
    const map = new Map<number, CodeComment[]>();
    for (const comment of comments) {
      const line = comment.endLine;
      if (!map.has(line)) map.set(line, []);
      map.get(line)!.push(comment);
    }
    return map;
  }, [comments]);

  const handleCommentBubbleClick = useCallback((comment: CodeComment, e: React.MouseEvent) => {
    e.stopPropagation();
    setViewingComment({ comment, x: e.clientX, y: e.clientY });
    clearToolbar();
    setAddCommentInput(null);
    setSendToAIInput(null);
  }, [clearToolbar]);

  const handleToolbarAddComment = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setAddCommentInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      selectedText: toolbar.selectedText,
      lineSnapshot: toolbar.lineSnapshot,
    });
    clearToolbar();
  }, [clearToolbar, floatingToolbarRef]);

  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      selectedText: toolbar.selectedText,
      lineSnapshot: toolbar.lineSnapshot,
    });
    clearToolbar();
  }, [clearToolbar, floatingToolbarRef]);

  // One-click explain — no question card, and not routed through
  // sendSelectionToAI (that one also ships and wipes the comment stack).
  const handleToolbarExplain = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar || !aiBridge) return;
    clearToolbar();
    sendReferenceToAI(
      aiBridge.sendMessage,
      {
        filePath,
        startLine: toolbar.range.start,
        endLine: toolbar.range.end,
        codeContent: toolbar.lineSnapshot,
      },
      i18n.t('explain.selectionMessage'),
    );
  }, [aiBridge, filePath, clearToolbar, floatingToolbarRef]);

  // Search the LITERAL selection — not the line-expanded snapshot. Using
  // the snapshot was the source of the long-standing "DiffView search
  // mysteriously expands to the whole line" bug.
  const handleToolbarSearch = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar || !onContentSearch) return;
    const query = toolbar.selectedText.trim();
    clearToolbar();
    if (query) onContentSearch(query);
  }, [onContentSearch, clearToolbar, floatingToolbarRef]);

  // Shared send-to-AI orchestration for both entries (standalone SendToAI
  // card / comment card button): all historical comments + the given
  // selection go out as one message, then the comment stack is cleared.
  const sendSelectionToAI = useCallback(async (selection: { range: { start: number; end: number }; lineSnapshot: string }, question: string) => {
    if (!aiBridge || !cwd) return;

    try {
      const allComments = await fetchAllCommentsWithCode(cwd);
      const references: CodeReference[] = [];

      for (const comment of allComments) {
        references.push({
          filePath: comment.filePath,
          startLine: comment.startLine,
          endLine: comment.endLine,
          codeContent: comment.codeContent,
          note: comment.content || undefined,
        });
      }

      references.push({
        filePath,
        startLine: selection.range.start,
        endLine: selection.range.end,
        codeContent: selection.lineSnapshot,
      });

      const message = buildAIMessage(references, question);
      aiBridge.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [aiBridge, filePath, cwd, refreshComments]);

  // Both cards close themselves on submit — deliberately NO trailing state
  // reset after the async send (a late set(null) could clobber a card the
  // user opened in the meantime).
  const handleSendToAISubmit = useCallback((question: string) => {
    if (!sendToAIInput) return;
    void sendSelectionToAI(sendToAIInput, question);
  }, [sendToAIInput, sendSelectionToAI]);

  const handleCommentSendToAI = useCallback((question: string) => {
    if (!addCommentInput) return;
    void sendSelectionToAI(addCommentInput, question);
  }, [addCommentInput, sendSelectionToAI]);

  const handleCommentSubmit = useCallback(async (content: string) => {
    if (!addCommentInput) return;
    await addComment(
      addCommentInput.range.start,
      addCommentInput.range.end,
      content,
      addCommentInput.selectedText,
    );
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Floating elements via Portal to menu container (keeps within second screen)
  const commentPortal = isMounted && menuContainer
    ? createPortal(
        <>
          <ToolbarRenderer
            floatingToolbarRef={floatingToolbarRef}
            bumpRef={bumpToolbarRef}
            container={menuContainer}
            onAddComment={handleToolbarAddComment}
            onSendToAI={handleToolbarSendToAI}
            onSearch={onContentSearch ? handleToolbarSearch : undefined}
            onExplain={aiBridge ? handleToolbarExplain : undefined}
            isChatLoading={aiBridge?.isLoading ?? false}
          />
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              filePath={filePath}
              lineSnapshot={addCommentInput.lineSnapshot}
              container={menuContainer}
              onSubmit={handleCommentSubmit}
              onSendToAI={aiBridge ? handleCommentSendToAI : undefined}
              onClose={() => setAddCommentInput(null)}
              isChatLoading={aiBridge?.isLoading}
            />
          )}
          {sendToAIInput && (
            <SendToAIInput
              x={sendToAIInput.x}
              y={sendToAIInput.y}
              range={sendToAIInput.range}
              filePath={filePath}
              lineSnapshot={sendToAIInput.lineSnapshot}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
              isChatLoading={aiBridge?.isLoading}
            />
          )}
          {viewingComment && (
            <ViewCommentCard
              x={viewingComment.x}
              y={viewingComment.y}
              comment={viewingComment.comment}
              container={menuContainer}
              onClose={() => setViewingComment(null)}
              onUpdateComment={updateComment}
              onDeleteComment={deleteComment}
            />
          )}
        </>,
        menuContainer,
      )
    : null;

  return {
    commentsEnabled,
    linesWithComments,
    commentsByEndLine,
    handleCommentBubbleClick,
    addCommentRange: addCommentInput?.range ?? null,
    sendToAIRange: sendToAIInput?.range ?? null,
    commentPortal,
  };
}
