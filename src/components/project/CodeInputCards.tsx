'use client';

import React, { useState, useEffect, useRef } from 'react';

// ============================================
// Shared Types
// ============================================

export interface LineRange {
  start: number;
  end: number;
}

// ============================================
// Add Comment Input Card
// ============================================

export interface AddCommentInputProps {
  x: number;
  y: number;
  range: LineRange;
  codeContent?: string;
  container?: HTMLElement | null;
  onSubmit: (content: string) => void;
  onClose: () => void;
}

export function AddCommentInput({ x, y, range, codeContent, container, onSubmit, onClose }: AddCommentInputProps) {
  const [content, setContent] = useState('');
  const [isSubmitting, setIsSubmitting] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const [position, setPosition] = useState({ x: 0, y: 0 });

  // Truncate code content (show only first few lines if too long)
  const displayCode = codeContent?.split('\n').slice(0, 5).join('\n');
  const hasMoreLines = codeContent ? codeContent.split('\n').length > 5 : false;

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
      setPosition({ x: relX, y: relY });
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

  return (
    <div
      ref={cardRef}
      className="absolute z-[200] w-[640px] bg-card border border-border rounded-lg shadow-lg overflow-hidden"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-2 bg-amber-9/10 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-amber-11">添加评论</span>
          {(range.start > 0 || range.end > 0) && (
            <span className="text-xs text-muted-foreground">行 {range.start}-{range.end}</span>
          )}
        </div>
      </div>
      {/* Code preview */}
      {codeContent && (
        <div className="px-3 py-2 bg-secondary/50 border-b border-border max-h-24 overflow-hidden">
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
          placeholder="输入评论..."
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
        <div className="mt-1 text-xs text-muted-foreground">
          {isSubmitting ? '提交中...' : 'Enter 提交 · Shift+Enter 换行'}
        </div>
      </div>
    </div>
  );
}

// ============================================
// Send to AI Input Card
// ============================================

export interface SendToAIInputProps {
  x: number;
  y: number;
  range: LineRange;
  filePath?: string;
  codeContent?: string;
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
  codeContent,
  container,
  onSubmit,
  onClose,
  isChatLoading
}: SendToAIInputProps) {
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
      setPosition({ x: relX, y: relY });
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
  const displayCode = codeContent?.split('\n').slice(0, 5).join('\n');
  const hasMoreLines = codeContent ? codeContent.split('\n').length > 5 : false;

  return (
    <div
      ref={cardRef}
      className="absolute z-[200] w-[640px] bg-card border border-border rounded-lg shadow-lg overflow-hidden"
      style={{ left: position.x, top: position.y }}
    >
      <div className="px-3 py-2 bg-brand/10 border-b border-border">
        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-brand">提问 AI</span>
          {(range.start > 0 || range.end > 0) && (
            <span className="text-xs text-muted-foreground">行 {range.start}-{range.end}</span>
          )}
        </div>
        {filePath && <div className="mt-1 text-xs text-muted-foreground truncate">{filePath}</div>}
      </div>
      {/* Code preview */}
      {codeContent && (
        <div className="px-3 py-2 bg-secondary/50 border-b border-border max-h-24 overflow-hidden">
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
          placeholder="输入你的问题..."
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
          {isChatLoading ? '正在生成中，请稍候...' : 'Enter 发送 · Shift+Enter 换行'}
        </div>
      </div>
    </div>
  );
}
