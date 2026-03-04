'use client';

import React, { useState, useCallback, useEffect, useRef, useImperativeHandle, forwardRef } from 'react';
import { toast, confirm } from '../shared/Toast';

export interface FileEditorHandle {
  save: () => void;
  close: () => void;
  isDirty: boolean;
  isSaving: boolean;
}

interface FileEditorInlineProps {
  filePath: string;
  initialContent: string;
  initialMtime?: number;
  cwd: string;
  /** 进入编辑时 CodeViewer 的当前可见行号（1-based） */
  initialLine?: number;
  onClose: (currentLine: number) => void;
  onSaved?: () => void;
  /** 通知父组件 dirty/saving 状态变化 */
  onStateChange?: (state: { isDirty: boolean; isSaving: boolean }) => void;
}

export const FileEditorInline = forwardRef<FileEditorHandle, FileEditorInlineProps>(function FileEditorInline({
  filePath,
  initialContent,
  initialMtime,
  cwd,
  initialLine,
  onClose,
  onSaved,
  onStateChange,
}, ref) {
  const [content, setContent] = useState(initialContent);
  const [isDirty, setIsDirty] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [conflictState, setConflictState] = useState<{
    show: boolean;
    diskContent?: string;
  }>({ show: false });
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const mtimeRef = useRef<number | undefined>(initialMtime);

  // Reset state when content changes (file switch)
  useEffect(() => {
    setContent(initialContent);
    setIsDirty(false);
    setConflictState({ show: false });
    mtimeRef.current = initialMtime;
  }, [initialContent, initialMtime]);

  // 通知父组件状态变化
  useEffect(() => {
    onStateChange?.({ isDirty, isSaving });
  }, [isDirty, isSaving, onStateChange]);

  // Mount 时 focus + 滚动到指定行
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.focus();
    if (initialLine && initialLine > 1) {
      const lh = getLineHeight();
      ta.scrollTop = (initialLine - 1) * lh;
      // 将光标放到目标行开头
      const lines = initialContent.split('\n');
      let charPos = 0;
      for (let i = 0; i < Math.min(initialLine - 1, lines.length); i++) {
        charPos += lines[i].length + 1; // +1 for \n
      }
      ta.setSelectionRange(charPos, charPos);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /** 获取实际行高（首次调用时测量并缓存） */
  const measuredLineHeight = useRef<number>(0);
  const getLineHeight = useCallback((): number => {
    if (measuredLineHeight.current > 0) return measuredLineHeight.current;
    const ta = textareaRef.current;
    if (!ta) return 20;
    const style = window.getComputedStyle(ta);
    measuredLineHeight.current = parseFloat(style.lineHeight) || 20;
    return measuredLineHeight.current;
  }, []);

  /** 获取当前可见首行号（1-based） */
  const getCurrentLine = useCallback((): number => {
    const ta = textareaRef.current;
    if (!ta) return initialLine || 1;
    return Math.floor(ta.scrollTop / getLineHeight()) + 1;
  }, [initialLine, getLineHeight]);

  const handleChange = useCallback((e: React.ChangeEvent<HTMLTextAreaElement>) => {
    const newContent = e.target.value;
    setContent(newContent);
    setIsDirty(newContent !== initialContent);
  }, [initialContent]);

  // Tab 键插入 2 空格
  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const ta = e.currentTarget;
      const start = ta.selectionStart;
      const end = ta.selectionEnd;
      const value = ta.value;
      const newValue = value.substring(0, start) + '  ' + value.substring(end);
      setContent(newValue);
      setIsDirty(newValue !== initialContent);
      // 恢复光标位置
      requestAnimationFrame(() => {
        ta.selectionStart = ta.selectionEnd = start + 2;
      });
    }
  }, [initialContent]);

  const doSave = useCallback(async (skipConflictCheck = false) => {
    setIsSaving(true);
    try {
      const response = await fetch('/api/files/save', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          cwd,
          path: filePath,
          content,
          expectedMtime: skipConflictCheck ? undefined : mtimeRef.current,
        }),
      });

      const data = await response.json();

      if (response.status === 409 && data.conflict) {
        try {
          const readRes = await fetch(`/api/files/read?cwd=${encodeURIComponent(cwd)}&path=${encodeURIComponent(filePath)}`);
          const readData = await readRes.json();
          setConflictState({
            show: true,
            diskContent: readData.type === 'text' ? readData.content : undefined,
          });
        } catch {
          setConflictState({ show: true });
        }
        return;
      }

      if (!response.ok) {
        throw new Error('Failed to save file');
      }

      if (data.mtime) {
        mtimeRef.current = data.mtime;
      }
      setIsDirty(false);
      setConflictState({ show: false });
      toast('已保存', 'success');
      onSaved?.();
    } catch (error) {
      console.error('Error saving file:', error);
      toast('保存失败', 'error');
    } finally {
      setIsSaving(false);
    }
  }, [cwd, filePath, content, onSaved]);

  const handleSave = useCallback(async () => {
    if (!isDirty || isSaving) return;
    await doSave(false);
  }, [isDirty, isSaving, doSave]);

  const handleForceOverwrite = useCallback(async () => {
    setConflictState({ show: false });
    await doSave(true);
  }, [doSave]);

  const handleRevertToDisk = useCallback(() => {
    if (conflictState.diskContent !== undefined) {
      setContent(conflictState.diskContent);
      setIsDirty(conflictState.diskContent !== initialContent);
    }
    setConflictState({ show: false });
    onSaved?.();
  }, [conflictState.diskContent, initialContent, onSaved]);

  // Cmd/Ctrl + S
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 's') {
        e.preventDefault();
        handleSave();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [handleSave]);

  const handleClose = useCallback(async () => {
    if (isDirty) {
      const ok = await confirm('有未保存的修改，确定关闭？', { danger: true, confirmText: '放弃修改', cancelText: '继续编辑' });
      if (!ok) return;
    }
    onClose(getCurrentLine());
  }, [isDirty, onClose, getCurrentLine]);

  // ESC to close
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        handleClose();
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [handleClose]);

  // Expose imperative handle
  useImperativeHandle(ref, () => ({
    save: handleSave,
    close: handleClose,
    get isDirty() { return isDirty; },
    get isSaving() { return isSaving; },
  }), [handleSave, handleClose, isDirty, isSaving]);

  // 行号（根据内容计算）
  const lineCount = content.split('\n').length;
  const lineNumChars = Math.max(4, String(lineCount).length);
  const lineNumberWidth = `${lineNumChars + 2}ch`;

  return (
    <div className="flex flex-col h-full">
      {/* 冲突提示条 */}
      {conflictState.show && (
        <div className="px-4 py-2 bg-amber-500/15 border-b border-amber-500/30 flex items-center gap-3 flex-shrink-0">
          <svg className="w-5 h-5 text-amber-500 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-2.5L13.732 4c-.77-.833-1.964-.833-2.732 0L4.082 16.5c-.77.833.192 2.5 1.732 2.5z" />
          </svg>
          <span className="text-sm text-foreground flex-1">
            文件已被外部修改，保存将覆盖外部更改
          </span>
          <div className="flex items-center gap-2">
            <button
              onClick={handleRevertToDisk}
              className="px-3 py-1 text-sm rounded border border-border hover:bg-accent transition-colors"
            >
              使用磁盘版本
            </button>
            <button
              onClick={handleForceOverwrite}
              className="px-3 py-1 text-sm rounded bg-amber-500 text-white hover:bg-amber-600 transition-colors"
            >
              强制覆盖
            </button>
          </div>
        </div>
      )}

      {/* Editor area with line numbers */}
      <div className="flex-1 overflow-hidden flex bg-secondary">
        {/* 行号列 */}
        <LineNumbers lineCount={lineCount} width={lineNumberWidth} textareaRef={textareaRef} />
        {/* textarea */}
        <textarea
          ref={textareaRef}
          value={content}
          onChange={handleChange}
          onKeyDown={handleKeyDown}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          className="flex-1 bg-secondary text-foreground font-mono text-sm leading-5 px-3 py-0 outline-none resize-none overflow-auto"
          style={{
            tabSize: 2,
            whiteSpace: 'pre',
            overflowWrap: 'normal',
          }}
        />
      </div>
    </div>
  );
});

/**
 * 行号列组件 — 与 textarea 滚动同步
 */
function LineNumbers({
  lineCount,
  width,
  textareaRef,
}: {
  lineCount: number;
  width: string | number;
  textareaRef: React.RefObject<HTMLTextAreaElement | null>;
}) {
  const lineNumRef = useRef<HTMLDivElement>(null);

  // 同步滚动
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;

    const syncScroll = () => {
      if (lineNumRef.current) {
        lineNumRef.current.scrollTop = ta.scrollTop;
      }
    };

    ta.addEventListener('scroll', syncScroll);
    return () => ta.removeEventListener('scroll', syncScroll);
  }, [textareaRef]);

  const lines = [];
  for (let i = 1; i <= lineCount; i++) {
    lines.push(
      <div key={i} className="text-right text-muted-foreground/50 select-none leading-5 pr-3">
        {i}
      </div>
    );
  }

  return (
    <div
      ref={lineNumRef}
      className="flex-shrink-0 font-mono text-sm overflow-hidden"
      style={{ width }}
    >
      {lines}
    </div>
  );
}

// Keep backward-compatible export name
export { FileEditorInline as FileEditorModal };
