'use client';

import React, { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';

// ============================================
// Shared Types
// ============================================

export interface LineRange {
  start: number;
  end: number;
}

// ============================================
// Add Comment Input Card
// (also hosts the "Send to AI" action — the former standalone
// SendToAIInput card was merged into this one)
// ============================================

export interface AddCommentInputProps {
  x: number;
  y: number;
  range: LineRange;
  /** File the selection belongs to — shown in the card header so the user
   *  knows what context a "Send to AI" would carry. Omitted for chat
   *  selections (no real file behind them). */
  filePath?: string;
  /** Whole-line / source-block expansion of the selection — what to show
   *  in the preview block. The literal selection (`selectedText`) is
   *  intentionally NOT what we preview here: code/diff comments are
   *  anchored to line ranges, so a full-line snapshot reads more
   *  naturally than a half-line literal selection. */
  lineSnapshot?: string;
  container?: HTMLElement | null;
  onSubmit: (content: string) => void;
  /** When provided, renders a "Send to AI" button next to "Submit comment".
   *  Clicking it hands the (non-empty) input text off as the question;
   *  the parent bundles all historical comments + the current selection
   *  into one AI message and clears the comment stack. Omit when no AI
   *  bridge is available — the button is then not rendered at all. */
  onSendToAI?: (question: string) => void;
  onClose: () => void;
  /** Disables ONLY the "Send to AI" button while the host is streaming an
   *  AI response. Comment submission stays available. */
  isChatLoading?: boolean;
}

export function AddCommentInput({ x, y, range, filePath, lineSnapshot, container, onSubmit, onSendToAI, onClose, isChatLoading }: AddCommentInputProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Truncate code content (show only first few lines if too long)
  const displayCode = lineSnapshot?.split('\n').slice(0, 5).join('\n');
  const hasMoreLines = lineSnapshot ? lineSnapshot.split('\n').length > 5 : false;

  // Position adjustment relative to container
  useEffect(() => {
    if (cardRef.current && container) {
      const containerRect = container.getBoundingClientRect();
      const cardRect = cardRef.current.getBoundingClientRect();
      // Calculate position relative to container
      let relX = x - containerRect.left;
      let relY = y - containerRect.top;
      // Avoid overflow
      if (relX + cardRect.width > containerRect.width - 16) relX = containerRect.width - cardRect.width - 16;
      if (relX < 16) relX = 16;
      if (relY + cardRect.height > containerRect.height - 16) relY = relY - cardRect.height - 8;
      if (relY < 16) relY = 16;
      queueMicrotask(() => setPosition({ x: relX, y: relY }));
    }
  }, [x, y, container]);

  // Auto focus
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Click outside to close (only when not submitting)
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (!isSubmitting && cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose, isSubmitting]);

  const handleSubmit = () => {
    if (isSubmitting || !content.trim()) return;
    setIsSubmitting(true);
    onSubmit(content.trim());
    // Component will be unmounted by parent, no need to setIsSubmitting(false)
  };

  // Send to AI — requires a non-empty question (same rule as the
  // standalone SendToAI card). Close immediately after dispatching so an
  // async failure in the parent can't leave the card stuck disabled.
  const handleSendToAI = () => {
    if (isSubmitting || isChatLoading || !onSendToAI || !content.trim()) return;
    setIsSubmitting(true);
    onSendToAI(content.trim());
    onClose();
  };

  return (
    <div
      ref={cardRef}
      className="absolute z-[200] w-[640px] bg-card border border-border rounded-lg shadow-lv2 overflow-hidden"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-2 bg-amber-9/10 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-amber-11">{t('comments.addComment')}</span>
          {(range.start > 0 || range.end > 0) && (
            <span className="text-xs text-muted-foreground">{t('comments.lineRange', { start: range.start, end: range.end })}</span>
          )}
        </div>
        {filePath && <div className="mt-1 text-xs text-muted-foreground truncate">{filePath}</div>}
      </div>
      {/* Code preview */}
      {lineSnapshot && (
        <div className="px-3 py-2 border-b border-border max-h-24 overflow-hidden">
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
            {displayCode}
            {hasMoreLines && <span className="text-muted-foreground/50">...</span>}
          </pre>
        </div>
      )}
      <div className="p-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('comments.inputPlaceholder')}
          className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card resize-none focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
          rows={2}
          disabled={isSubmitting}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === 'Escape' && !isSubmitting) {
              onClose();
            }
          }}
        />
        <div className="mt-1 flex items-center justify-between gap-2">
          <span className="text-xs text-muted-foreground">
            {isSubmitting ? t('comments.submitting') : t('comments.enterSubmit')}
          </span>
          <div className="flex items-center gap-1.5">
            <button
              className="px-3 py-1 text-xs font-medium border border-amber-11 text-amber-11 rounded-md hover:bg-amber-9/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
              onClick={handleSubmit}
              disabled={isSubmitting || !content.trim()}
            >
              {t('comments.submitComment')}
            </button>
            {onSendToAI && (
              <button
                className="px-3 py-1 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                onClick={handleSendToAI}
                disabled={isSubmitting || isChatLoading || !content.trim()}
                title={isChatLoading ? t('comments.aiResponding') : undefined}
              >
                {t('comments.sendToAI')}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

// ============================================
// Send to AI Input Card (standalone, opened from the floating toolbar)
// ============================================

export interface SendToAIInputProps {
  x: number;
  y: number;
  range: LineRange;
  filePath?: string;
  /** Whole-line / source-block expansion of the selection — what to show
   *  in the preview block and (downstream) what to send to the AI as
   *  `CodeReference.codeContent`. See `ToolbarData.lineSnapshot` for the
   *  full rationale on why this is the line-expanded version rather than
   *  the literal selection. */
  lineSnapshot?: string;
  container?: HTMLElement | null;
  onSubmit: (question: string) => void;
  onClose: () => void;
  isChatLoading?: boolean;
}

export function SendToAIInput({
  x,
  y,
  range,
  filePath,
  lineSnapshot,
  container,
  onSubmit,
  onClose,
  isChatLoading
}: SendToAIInputProps) {
  const { t } = useTranslation();
  const [content, setContent] = useState('');
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Position adjustment relative to container
  useEffect(() => {
    if (cardRef.current && container) {
      const containerRect = container.getBoundingClientRect();
      const cardRect = cardRef.current.getBoundingClientRect();
      // Calculate position relative to container
      let relX = x - containerRect.left;
      let relY = y - containerRect.top;
      // Avoid overflow
      if (relX + cardRect.width > containerRect.width - 16) relX = containerRect.width - cardRect.width - 16;
      if (relX < 16) relX = 16;
      if (relY + cardRect.height > containerRect.height - 16) relY = relY - cardRect.height - 8;
      if (relY < 16) relY = 16;
      queueMicrotask(() => setPosition({ x: relX, y: relY }));
    }
  }, [x, y, container]);

  // Auto focus
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  // Click outside to close
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [onClose]);

  const handleSubmit = () => {
    if (isChatLoading || !content.trim()) return;
    onSubmit(content.trim());
    onClose();
  };

  // Truncate code content (show only first few lines if too long)
  const displayCode = lineSnapshot?.split('\n').slice(0, 5).join('\n');
  const hasMoreLines = lineSnapshot ? lineSnapshot.split('\n').length > 5 : false;

  return (
    <div
      ref={cardRef}
      className="absolute z-[200] w-[640px] bg-card border border-border rounded-lg shadow-lv2 overflow-hidden"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-2 bg-brand/10 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-brand">{t('comments.askAI')}</span>
          {(range.start > 0 || range.end > 0) && (
            <span className="text-xs text-muted-foreground">{t('comments.lineRange', { start: range.start, end: range.end })}</span>
          )}
        </div>
        {filePath && <div className="mt-1 text-xs text-muted-foreground truncate">{filePath}</div>}
      </div>
      {/* Code preview */}
      {lineSnapshot && (
        <div className="px-3 py-2 border-b border-border max-h-24 overflow-hidden">
          <pre className="text-xs font-mono text-muted-foreground whitespace-pre-wrap break-all">
            {displayCode}
            {hasMoreLines && <span className="text-muted-foreground/50">...</span>}
          </pre>
        </div>
      )}
      <div className="p-2">
        <textarea
          ref={textareaRef}
          value={content}
          onChange={(e) => setContent(e.target.value)}
          placeholder={t('comments.inputQuestion')}
          className="w-full px-2 py-1.5 text-sm border border-border rounded bg-card resize-none focus:outline-none focus:ring-1 focus:ring-ring disabled:opacity-50 disabled:cursor-not-allowed"
          rows={2}
          disabled={isChatLoading}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              handleSubmit();
            }
            if (e.key === 'Escape') {
              onClose();
            }
          }}
        />
        <div className="mt-1 text-xs text-muted-foreground">
          {isChatLoading ? t('comments.aiGenerating') : t('comments.enterSend')}
        </div>
      </div>
    </div>
  );
}
