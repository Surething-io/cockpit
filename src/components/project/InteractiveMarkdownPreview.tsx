'use client';

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { createPortal } from 'react-dom';
import { useMenuContainer } from './FileContextMenu';
import { ToolbarRenderer, type ToolbarData } from './FloatingToolbar';
import { AddCommentInput, SendToAIInput } from './CodeInputCards';
import { ViewCommentCard } from './ViewCommentCard';
import { useComments } from '@/hooks/useComments';
import { useChatContextOptional } from './ChatContext';
import { fetchAllCommentsWithCode, clearAllComments, buildAIMessage, type CodeReference } from '@/hooks/useAllComments';
import { MarkdownRenderer } from '../shared/MarkdownRenderer';
import { rehypeSourceLines } from '@/lib/rehypeSourceLines';
import type { CodeComment } from '@/hooks/useComments';
import { TocSidebar } from '../shared/TocSidebar';
import { ShareReviewToggle } from '../shared/ShareReviewToggle';

// ============================================
// InteractiveMarkdownPreview
// Markdown 预览 + 框选评论 + 发送 AI
// 所有交互映射回原始 MD 源码行范围
// ============================================

interface InteractiveMarkdownPreviewProps {
  content: string;       // 原始 markdown 源码
  filePath: string;      // 文件路径（评论数据绑定 + 发送 AI 引用）
  cwd: string;           // useComments + fetchAllCommentsWithCode
  onClose: () => void;
  /** 相对路径，用于 review sourceFile 匹配。不传则从 filePath + cwd 推导 */
  sourceFile?: string;
}

interface InputCardData {
  x: number;
  y: number;
  range: { start: number; end: number };
  codeContent: string;
}

interface ViewingCommentData {
  comment: CodeComment;
  x: number;
  y: number;
}

// 从 DOM 节点向上查找 data-source-start/end 属性
function getSourceRange(node: Node): { start: number; end: number } | null {
  const el = node.nodeType === Node.TEXT_NODE ? node.parentElement : node as Element;
  if (!el || !('closest' in el)) return null;
  const block = (el as HTMLElement).closest('[data-source-start]') as HTMLElement | null;
  if (!block) return null;
  const start = block.getAttribute('data-source-start');
  const end = block.getAttribute('data-source-end');
  if (!start || !end) return null;
  return { start: parseInt(start, 10), end: parseInt(end, 10) };
}

// rehypePlugins 数组保持引用稳定避免 ReactMarkdown 重渲染
const REHYPE_PLUGINS = [rehypeSourceLines];

export function InteractiveMarkdownPreview({
  content,
  filePath,
  cwd,
  onClose,
  sourceFile: sourceFileProp,
}: InteractiveMarkdownPreviewProps) {
  // 推导 sourceFile（相对路径）
  const sourceFile = sourceFileProp
    || (cwd && filePath.startsWith(cwd) ? filePath.slice(cwd.endsWith('/') ? cwd.length : cwd.length + 1) : filePath);
  // === Refs ===
  const containerRef = useRef<HTMLDivElement>(null);
  const floatingToolbarRef = useRef<ToolbarData | null>(null);
  const bumpToolbarRef = useRef<() => void>(() => {});

  // === Hooks ===
  const menuContainer = useMenuContainer();
  const chatContext = useChatContextOptional();
  const { comments, addComment, updateComment, deleteComment, refresh: refreshComments } = useComments({ cwd, filePath });
  const [isMounted, setIsMounted] = useState(false);

  // === Floating UI state ===
  const [addCommentInput, setAddCommentInput] = useState<InputCardData | null>(null);
  const [sendToAIInput, setSendToAIInput] = useState<InputCardData | null>(null);
  const [viewingComment, setViewingComment] = useState<ViewingCommentData | null>(null);

  // === Source lines for extracting original content ===
  const sourceLines = useMemo(() => content.split('\n'), [content]);

  useEffect(() => { setIsMounted(true); }, []);

  // ============================================
  // 选区检测 → FloatingToolbar
  // 与 useCodeViewerLogic 相同的 ref 模式
  // ============================================
  useEffect(() => {
    const area = containerRef.current;
    if (!area) return;
    let isDragging = false;
    let downX = 0, downY = 0;

    const handleMouseDown = (e: MouseEvent) => {
      isDragging = true;
      downX = e.clientX;
      downY = e.clientY;
      // 清除上一次 toolbar
      if (floatingToolbarRef.current) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    const handleMouseUp = (e: MouseEvent) => {
      isDragging = false;

      // 忽略 toolbar/input card 自身的点击
      const target = e.target as HTMLElement;
      if (target.closest?.('.floating-toolbar') || target.closest?.('[data-comment-card]')) return;

      const moved = Math.abs(e.clientX - downX) > 5 || Math.abs(e.clientY - downY) > 5;
      const selection = window.getSelection();
      if (!selection || selection.isCollapsed) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
        return;
      }

      const selectedText = selection.toString();
      if (!selectedText.trim() || !moved) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
        return;
      }

      const range = selection.getRangeAt(0);
      if (!area.contains(range.commonAncestorContainer)) return;

      // 从选区两端查找 data-source-* 属性
      const startRange = getSourceRange(range.startContainer);
      const endRange = getSourceRange(range.endContainer);

      if (startRange && endRange) {
        const minStart = Math.min(startRange.start, endRange.start);
        const maxEnd = Math.max(startRange.end, endRange.end);
        floatingToolbarRef.current = {
          x: e.clientX,
          y: e.clientY,
          range: { start: minStart, end: maxEnd },
          selectedText,
        };
        bumpToolbarRef.current();
      }
    };

    const handleSelectionChange = () => {
      if (isDragging) return;
      if (!floatingToolbarRef.current) return;
      const sel = window.getSelection();
      if (!sel || sel.isCollapsed || !sel.toString().trim()) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
      }
    };

    area.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('mouseup', handleMouseUp);
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      area.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('mouseup', handleMouseUp);
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, []);

  // ============================================
  // Toolbar action handlers
  // ============================================

  const handleToolbarAddComment = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setAddCommentInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent: toolbar.selectedText,
    });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
  }, []);

  const handleToolbarSendToAI = useCallback(() => {
    const toolbar = floatingToolbarRef.current;
    if (!toolbar) return;
    setSendToAIInput({
      x: toolbar.x,
      y: toolbar.y,
      range: toolbar.range,
      codeContent: toolbar.selectedText,
    });
    floatingToolbarRef.current = null;
    bumpToolbarRef.current();
  }, []);

  // Submit comment
  const handleCommentSubmit = useCallback(async (commentContent: string) => {
    if (!addCommentInput) return;
    await addComment(addCommentInput.range.start, addCommentInput.range.end, commentContent);
    setAddCommentInput(null);
  }, [addCommentInput, addComment]);

  // Submit to AI — 同 useCodeViewerLogic 逻辑
  const handleSendToAISubmit = useCallback(async (question: string) => {
    if (!sendToAIInput || !chatContext) return;

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

      // 当前选中：提取原始 Markdown 源码对应行
      const startIdx = Math.max(0, sendToAIInput.range.start - 1);
      const endIdx = Math.min(sourceLines.length, sendToAIInput.range.end);
      const selectedSourceContent = sourceLines.slice(startIdx, endIdx).join('\n');

      references.push({
        filePath,
        startLine: sendToAIInput.range.start,
        endLine: sendToAIInput.range.end,
        codeContent: selectedSourceContent,
      });

      const message = buildAIMessage(references, question);
      chatContext.sendMessage(message);

      await clearAllComments(cwd);
      refreshComments();
      setSendToAIInput(null);
    } catch (err) {
      console.error('Failed to send to AI:', err);
    }
  }, [sendToAIInput, chatContext, filePath, cwd, sourceLines, refreshComments]);

  // ============================================
  // 已有评论指示器定位
  // ============================================

  // 按评论行范围分组
  const commentGroups = useMemo(() => {
    if (comments.length === 0) return [];
    // 用 startLine-endLine 作为 key 分组
    const map = new Map<string, CodeComment[]>();
    for (const c of comments) {
      const key = `${c.startLine}-${c.endLine}`;
      if (!map.has(key)) map.set(key, []);
      map.get(key)!.push(c);
    }
    return Array.from(map.entries()).map(([key, group]) => ({
      key,
      startLine: group[0].startLine,
      endLine: group[0].endLine,
      comments: group,
    }));
  }, [comments]);

  const [commentPositions, setCommentPositions] = useState<
    Array<{ key: string; top: number; comments: CodeComment[] }>
  >([]);

  useEffect(() => {
    if (commentGroups.length === 0 || !containerRef.current) {
      setCommentPositions([]);
      return;
    }
    // 稍等 MarkdownRenderer 完成渲染
    const timer = setTimeout(() => {
      const container = containerRef.current;
      if (!container) return;
      const positions: typeof commentPositions = [];
      const allAnnotated = container.querySelectorAll('[data-source-start]');

      for (const group of commentGroups) {
        // 找最小包含评论行范围的 DOM 元素
        let bestEl: HTMLElement | null = null;
        let bestSize = Infinity;
        for (const el of allAnnotated) {
          const s = parseInt(el.getAttribute('data-source-start')!, 10);
          const e = parseInt(el.getAttribute('data-source-end')!, 10);
          if (s <= group.startLine && e >= group.endLine) {
            const size = e - s;
            if (size < bestSize) {
              bestSize = size;
              bestEl = el as HTMLElement;
            }
          }
        }
        if (bestEl) {
          const containerRect = container.getBoundingClientRect();
          const elRect = bestEl.getBoundingClientRect();
          positions.push({
            key: group.key,
            top: elRect.top - containerRect.top + container.scrollTop,
            comments: group.comments,
          });
        }
      }
      setCommentPositions(positions);
    }, 100);
    return () => clearTimeout(timer);
  }, [commentGroups, content]);

  // ============================================
  // ESC 键分层关闭
  // ============================================
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (sendToAIInput) { setSendToAIInput(null); e.stopPropagation(); return; }
      if (addCommentInput) { setAddCommentInput(null); e.stopPropagation(); return; }
      if (floatingToolbarRef.current) {
        floatingToolbarRef.current = null;
        bumpToolbarRef.current();
        e.stopPropagation();
        return;
      }
      if (viewingComment) { setViewingComment(null); e.stopPropagation(); return; }
      onClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [sendToAIInput, addCommentInput, viewingComment, onClose]);

  // ============================================
  // Render
  // ============================================
  return (
    <>
      {/* Header */}
      <div className="px-4 py-3 border-b border-border flex items-center justify-between flex-shrink-0">
        <span className="text-sm font-medium text-foreground truncate">{filePath}</span>
        <div className="flex items-center gap-3">
          <ShareReviewToggle content={content} sourceFile={sourceFile} />
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title="关闭"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      </div>

      {/* Body: TOC sidebar + content */}
      <div className="flex-1 flex overflow-hidden">
        <TocSidebar content={content} containerRef={containerRef} />

        {/* Scrollable content */}
        <div className="flex-1 overflow-auto relative" ref={containerRef}>
          <div className="p-6">
            <MarkdownRenderer
              content={content}
              rehypePlugins={REHYPE_PLUGINS}
            />
          </div>

          {/* 评论指示器 */}
          {commentPositions.map(({ key, top, comments: lineComments }) => (
            <div
              key={key}
              className="absolute right-3 cursor-pointer z-10"
              style={{ top }}
              onClick={(e) => {
                e.stopPropagation();
                setViewingComment({
                  comment: lineComments[0],
                  x: e.clientX,
                  y: e.clientY,
                });
              }}
            >
              <div className="w-5 h-5 rounded-full bg-amber-500/80 text-white text-xs flex items-center justify-center shadow-sm hover:bg-amber-500 transition-colors">
                {lineComments.length}
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Floating UI via Portal */}
      {isMounted && menuContainer && createPortal(
        <>
          <ToolbarRenderer
            floatingToolbarRef={floatingToolbarRef}
            bumpRef={bumpToolbarRef}
            container={menuContainer}
            onAddComment={handleToolbarAddComment}
            onSendToAI={handleToolbarSendToAI}
            isChatLoading={chatContext?.isLoading}
          />
          {addCommentInput && (
            <AddCommentInput
              x={addCommentInput.x}
              y={addCommentInput.y}
              range={addCommentInput.range}
              codeContent={addCommentInput.codeContent}
              container={menuContainer}
              onSubmit={handleCommentSubmit}
              onClose={() => setAddCommentInput(null)}
            />
          )}
          {sendToAIInput && (
            <SendToAIInput
              x={sendToAIInput.x}
              y={sendToAIInput.y}
              range={sendToAIInput.range}
              filePath={filePath}
              codeContent={sendToAIInput.codeContent}
              container={menuContainer}
              onSubmit={handleSendToAISubmit}
              onClose={() => setSendToAIInput(null)}
              isChatLoading={chatContext?.isLoading}
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
      )}
    </>
  );
}
