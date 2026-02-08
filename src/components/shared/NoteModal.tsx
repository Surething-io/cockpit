'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItem } from '@tiptap/extension-task-item';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { getMarkdown } from './slashCommands';
import { SlashCommandMenu } from './SlashCommandMenu';
import { NoteToolbar } from './NoteToolbar';

// ============================================
// NoteModal 主组件
// ============================================

interface NoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectCwd?: string | null;
  projectName?: string | null;
}

export function NoteModal({ isOpen, onClose, projectCwd, projectName }: NoteModalProps) {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnsavedChanges = useRef(false);

  // 斜杠命令状态
  const [slashMenu, setSlashMenu] = useState<{ query: string; position: { top: number; left: number } } | null>(null);
  const slashStartPos = useRef<number | null>(null);

  // API URL（全局笔记 vs 项目笔记）
  const noteApiUrl = projectCwd
    ? `/api/note?cwd=${encodeURIComponent(projectCwd)}`
    : '/api/note';

  // 保存笔记
  const saveNote = useCallback(async (content: string) => {
    setIsSaving(true);
    try {
      await fetch(noteApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ content }),
      });
      hasUnsavedChanges.current = false;
    } catch (error) {
      console.error('Failed to save note:', error);
    } finally {
      setIsSaving(false);
    }
  }, [noteApiUrl]);

  // 5 秒防抖保存
  const debouncedSave = useCallback((content: string) => {
    hasUnsavedChanges.current = true;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveNote(content);
    }, 5000);
  }, [saveNote]);

  // Tiptap 编辑器
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [1, 2, 3] },
      }),
      Placeholder.configure({
        placeholder: '写点什么... 输入 / 打开快捷命令',
      }),
      Table.configure({ resizable: true }),
      TableRow,
      TableCell,
      TableHeader,
      TaskList,
      Link.configure({
        autolink: true,
        linkOnPaste: true,
        openOnClick: false,
        HTMLAttributes: {
          class: 'tiptap-link',
          target: '_blank',
          rel: 'noopener noreferrer',
        },
      }),
      TaskItem.configure({ nested: true }),
      Markdown.configure({
        html: true,
        transformCopiedText: true,
        transformPastedText: true,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-editor focus:outline-none min-h-[60vh] px-6 py-4',
      },
      handleClick: (view, pos, event) => {
        // Cmd/Ctrl + 点击打开链接
        if (event.metaKey || event.ctrlKey) {
          const attrs = view.state.doc.resolve(pos).marks().find(m => m.type.name === 'link')?.attrs;
          if (attrs?.href) {
            window.open(attrs.href, '_blank', 'noopener,noreferrer');
            return true;
          }
        }
        return false;
      },
      handleKeyDown: (_view, event) => {
        // Backspace 在空代码块中退出代码块
        if (event.key === 'Backspace' && editorRef.current) {
          const ed = editorRef.current;
          if (ed.isActive('codeBlock')) {
            const { $from } = ed.state.selection;
            const node = $from.node($from.depth);
            if (node.type.name === 'codeBlock' && node.textContent === '') {
              ed.chain().focus().toggleCodeBlock().run();
              return true;
            }
          }
        }
        // 输入 / 时触发斜杠命令
        if (event.key === '/' && !slashMenu) {
          setTimeout(() => {
            if (!editorRef.current) return;
            const { from } = editorRef.current.state.selection;
            const textBefore = editorRef.current.state.doc.textBetween(
              Math.max(0, from - 1), from, '\n'
            );
            if (textBefore === '/') {
              slashStartPos.current = from;
              const coords = editorRef.current.view.coordsAtPos(from);
              setSlashMenu({
                query: '',
                position: { top: coords.bottom + 4, left: coords.left },
              });
            }
          }, 0);
        }
        return false;
      },
    },
    onUpdate: ({ editor }) => {
      const md = getMarkdown(editor);
      debouncedSave(md);

      // 更新斜杠命令查询
      if (slashStartPos.current !== null) {
        const { from } = editor.state.selection;
        if (from < slashStartPos.current) {
          setSlashMenu(null);
          slashStartPos.current = null;
        } else {
          const query = editor.state.doc.textBetween(slashStartPos.current, from, '\n');
          if (query.includes(' ') || query.includes('\n')) {
            setSlashMenu(null);
            slashStartPos.current = null;
          } else {
            setSlashMenu((prev) => prev ? { ...prev, query } : null);
          }
        }
      }
    },
  });

  // 保存 editor ref 供 handleKeyDown 闭包使用
  const editorRef = useRef(editor);
  useEffect(() => {
    editorRef.current = editor;
  }, [editor]);

  // 打开时加载内容
  useEffect(() => {
    if (!isOpen || !editor) return;

    setIsLoading(true);
    setSlashMenu(null);
    slashStartPos.current = null;
    fetch(noteApiUrl)
      .then(res => res.json())
      .then(data => {
        editor.commands.setContent(data.content || '');
        hasUnsavedChanges.current = false;
      })
      .catch(err => console.error('Failed to load note:', err))
      .finally(() => setIsLoading(false));
  }, [isOpen, editor, noteApiUrl]);

  // 关闭时保存
  const handleClose = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (hasUnsavedChanges.current && editor) {
      const md = getMarkdown(editor);
      saveNote(md);
    }
    setSlashMenu(null);
    slashStartPos.current = null;
    onClose();
  }, [editor, saveNote, onClose]);

  // 清理 timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // ESC 关闭（斜杠菜单打开时 ESC 先关闭菜单）
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (slashMenu) {
          setSlashMenu(null);
          slashStartPos.current = null;
        } else {
          handleClose();
        }
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, handleClose, slashMenu]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* 背景遮罩 */}
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      {/* Modal */}
      <div className="relative bg-card rounded-lg shadow-xl w-full max-w-6xl h-[90vh] mx-4 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">{projectName ? `${projectName} - 笔记` : '笔记'}</h2>
            {isSaving && (
              <span className="text-xs text-muted-foreground">保存中...</span>
            )}
          </div>
          <button
            onClick={handleClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* 工具栏 */}
        <NoteToolbar editor={editor} />

        {/* 编辑器区域 */}
        <div className="flex-1 overflow-y-auto">
          {isLoading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground">
              <span>加载中...</span>
            </div>
          ) : (
            <EditorContent editor={editor} />
          )}
        </div>
      </div>

      {/* 斜杠命令菜单 */}
      {slashMenu && editor && (
        <SlashCommandMenu
          editor={editor}
          query={slashMenu.query}
          position={slashMenu.position}
          onClose={() => {
            setSlashMenu(null);
            slashStartPos.current = null;
          }}
        />
      )}
    </div>
  );
}
