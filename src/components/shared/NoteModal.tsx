'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { useEditor, EditorContent, Editor } from '@tiptap/react';
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

// ---- 获取 Markdown 内容的辅助函数 ----
function getMarkdown(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (editor.storage as any).markdown.getMarkdown() as string;
}

// ---- 斜杠命令定义 ----
interface SlashCommand {
  label: string;
  icon: string;
  description: string;
  action: (editor: Editor) => void;
}

const slashCommands: SlashCommand[] = [
  {
    label: '标题 1', icon: 'H1', description: '大标题',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: '标题 2', icon: 'H2', description: '中标题',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: '标题 3', icon: 'H3', description: '小标题',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: '无序列表', icon: '•', description: '项目符号列表',
    action: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: '有序列表', icon: '1.', description: '编号列表',
    action: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: '待办列表', icon: '☑', description: '可勾选的任务列表',
    action: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    label: '引用', icon: '❝', description: '引用块',
    action: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    label: '代码块', icon: '<>', description: '代码片段',
    action: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: '表格', icon: '▦', description: '插入 3×3 表格',
    action: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    label: '分割线', icon: '──', description: '水平分割线',
    action: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    label: '链接', icon: '🔗', description: '插入超链接',
    action: (_editor) => {
      // 通过 toolbar 的 link 按钮触发，这里触发自定义事件
      window.dispatchEvent(new CustomEvent('tiptap-insert-link'));
    },
  },
];

// ---- 链接输入弹窗组件 ----
function LinkInput({
  editor,
  onClose,
  position,
}: {
  editor: Editor;
  onClose: () => void;
  position: { top: number; left: number } | null;
}) {
  const [url, setUrl] = useState(() => {
    // 如果当前选中的是链接，预填 URL
    const attrs = editor.getAttributes('link');
    return attrs.href || '';
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  const handleSubmit = () => {
    const trimmed = url.trim();
    if (trimmed) {
      // 自动补全协议
      const href = trimmed.match(/^https?:\/\//) ? trimmed : `https://${trimmed}`;
      editor.chain().focus().extendMarkRange('link').setLink({ href }).run();
    } else {
      // 空 URL，移除链接
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
    }
    onClose();
  };

  const handleRemove = () => {
    editor.chain().focus().extendMarkRange('link').unsetLink().run();
    onClose();
  };

  const style = position
    ? { top: position.top, left: position.left }
    : {};

  return (
    <div
      className={`${position ? 'fixed' : 'absolute top-full left-0 mt-1'} z-[60] bg-popover border border-border rounded-lg shadow-lg p-2 flex items-center gap-2`}
      style={style}
    >
      <input
        ref={inputRef}
        type="text"
        value={url}
        onChange={(e) => setUrl(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            e.preventDefault();
            handleSubmit();
          } else if (e.key === 'Escape') {
            e.preventDefault();
            onClose();
          }
        }}
        placeholder="输入链接地址..."
        className="bg-background border border-border rounded px-2 py-1 text-sm w-64 outline-none focus:border-brand"
      />
      <button
        onClick={handleSubmit}
        className="p-1 rounded text-sm font-medium text-brand hover:bg-brand/10 transition-colors"
        title="确认"
      >
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M9 16.17L4.83 12l-1.42 1.41L9 19 21 7l-1.41-1.41z"/></svg>
      </button>
      {editor.isActive('link') && (
        <button
          onClick={handleRemove}
          className="p-1 rounded text-sm font-medium text-red-500 hover:bg-red-500/10 transition-colors"
          title="移除链接"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
        </button>
      )}
    </div>
  );
}

// ---- 工具栏组件 ----
function Toolbar({ editor }: { editor: Editor | null }) {
  const [showLinkInput, setShowLinkInput] = useState(false);
  const linkBtnRef = useRef<HTMLButtonElement>(null);
  const [, forceUpdate] = useState(0);

  // 监听编辑器 selection/transaction 变化，实时刷新工具栏状态
  useEffect(() => {
    if (!editor) return;
    const handler = () => forceUpdate((n) => n + 1);
    editor.on('selectionUpdate', handler);
    editor.on('transaction', handler);
    return () => {
      editor.off('selectionUpdate', handler);
      editor.off('transaction', handler);
    };
  }, [editor]);

  // 监听来自 slash 命令的链接插入事件
  useEffect(() => {
    const handler = () => setShowLinkInput(true);
    window.addEventListener('tiptap-insert-link', handler);
    return () => window.removeEventListener('tiptap-insert-link', handler);
  }, []);

  if (!editor) return null;

  const btnClass = (active: boolean) =>
    `p-1.5 rounded text-xs font-medium transition-colors ${
      active
        ? 'bg-brand/15 text-brand'
        : 'text-muted-foreground hover:text-foreground hover:bg-accent'
    }`;

  const sepClass = 'w-px h-5 bg-border mx-0.5';

  const isInTable = editor.isActive('table');

  return (
    <div className="flex items-center gap-0.5 px-4 py-1.5 border-b border-border flex-shrink-0 flex-wrap">
      {/* 标题 */}
      <button className={btnClass(editor.isActive('heading', { level: 1 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 1 }).run()} title="标题 1">H1</button>
      <button className={btnClass(editor.isActive('heading', { level: 2 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()} title="标题 2">H2</button>
      <button className={btnClass(editor.isActive('heading', { level: 3 }))} onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()} title="标题 3">H3</button>

      <div className={sepClass} />

      {/* 行内格式 */}
      <button className={btnClass(editor.isActive('bold'))} onClick={() => editor.chain().focus().toggleBold().run()} title="粗体">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M15.6 10.79c.97-.67 1.65-1.77 1.65-2.79 0-2.26-1.75-4-4-4H7v14h7.04c2.09 0 3.71-1.7 3.71-3.79 0-1.52-.86-2.82-2.15-3.42zM10 6.5h3c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5h-3v-3zm3.5 9H10v-3h3.5c.83 0 1.5.67 1.5 1.5s-.67 1.5-1.5 1.5z"/></svg>
      </button>
      <button className={btnClass(editor.isActive('italic'))} onClick={() => editor.chain().focus().toggleItalic().run()} title="斜体">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10 4v3h2.21l-3.42 8H6v3h8v-3h-2.21l3.42-8H18V4z"/></svg>
      </button>
      <button className={btnClass(editor.isActive('strike'))} onClick={() => editor.chain().focus().toggleStrike().run()} title="删除线">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M10 19h4v-3h-4v3zM5 4v3h5v3h4V7h5V4H5zM3 14h18v-2H3v2z"/></svg>
      </button>
      <button className={btnClass(editor.isActive('code'))} onClick={() => editor.chain().focus().toggleCode().run()} title="行内代码">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M9.4 16.6L4.8 12l4.6-4.6L8 6l-6 6 6 6 1.4-1.4zm5.2 0l4.6-4.6-4.6-4.6L16 6l6 6-6 6-1.4-1.4z"/></svg>
      </button>

      <div className={sepClass} />

      {/* 链接 */}
      <div className="relative">
        <button
          ref={linkBtnRef}
          className={btnClass(editor.isActive('link'))}
          onClick={() => setShowLinkInput(!showLinkInput)}
          title="链接"
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M3.9 12c0-1.71 1.39-3.1 3.1-3.1h4V7H7c-2.76 0-5 2.24-5 5s2.24 5 5 5h4v-1.9H7c-1.71 0-3.1-1.39-3.1-3.1zM8 13h8v-2H8v2zm9-6h-4v1.9h4c1.71 0 3.1 1.39 3.1 3.1s-1.39 3.1-3.1 3.1h-4V17h4c2.76 0 5-2.24 5-5s-2.24-5-5-5z"/></svg>
        </button>
        {showLinkInput && (
          <LinkInput
            editor={editor}
            onClose={() => setShowLinkInput(false)}
            position={null}
          />
        )}
      </div>

      <div className={sepClass} />

      {/* 列表 */}
      <button className={btnClass(editor.isActive('bulletList'))} onClick={() => editor.chain().focus().toggleBulletList().run()} title="无序列表">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M4 10.5c-.83 0-1.5.67-1.5 1.5s.67 1.5 1.5 1.5 1.5-.67 1.5-1.5-.67-1.5-1.5-1.5zm0-6c-.83 0-1.5.67-1.5 1.5S3.17 7.5 4 7.5 5.5 6.83 5.5 6 4.83 4.5 4 4.5zm0 12c-.83 0-1.5.68-1.5 1.5s.68 1.5 1.5 1.5 1.5-.68 1.5-1.5-.67-1.5-1.5-1.5zM7 19h14v-2H7v2zm0-6h14v-2H7v2zm0-8v2h14V5H7z"/></svg>
      </button>
      <button className={btnClass(editor.isActive('orderedList'))} onClick={() => editor.chain().focus().toggleOrderedList().run()} title="有序列表">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M2 17h2v.5H3v1h1v.5H2v1h3v-4H2v1zm1-9h1V4H2v1h1v3zm-1 3h1.8L2 13.1v.9h3v-1H3.2L5 10.9V10H2v1zm5-6v2h14V5H7zm0 14h14v-2H7v2zm0-6h14v-2H7v2z"/></svg>
      </button>
      <button className={btnClass(editor.isActive('taskList'))} onClick={() => editor.chain().focus().toggleTaskList().run()} title="待办列表">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M19 3H5c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h14c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H5V5h14v14zM17.99 9l-1.41-1.42-6.59 6.59-2.58-2.57-1.42 1.41 4 3.99z"/></svg>
      </button>

      <div className={sepClass} />

      {/* 块级 */}
      <button className={btnClass(editor.isActive('blockquote'))} onClick={() => editor.chain().focus().toggleBlockquote().run()} title="引用">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 17h3l2-4V7H5v6h3zm8 0h3l2-4V7h-6v6h3z"/></svg>
      </button>
      <button className={btnClass(editor.isActive('codeBlock'))} onClick={() => editor.chain().focus().toggleCodeBlock().run()} title="代码块">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20 3H4c-1.1 0-2 .9-2 2v14c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V5c0-1.1-.9-2-2-2zm0 16H4V5h16v14zm-7.5-4.5L15 12l-2.5-2.5L11 11l1.5 1.5L11 14l1.5 1.5zM9.5 14.5L7 12l2.5-2.5L11 11 9.5 12.5 11 14l-1.5.5z"/></svg>
      </button>
      <button className={btnClass(false)} onClick={() => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run()} title="表格">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20 2H4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V4c0-1.1-.9-2-2-2zm-9 15H4v-4h7v4zm0-6H4V7h7v4zm9 6h-7v-4h7v4zm0-6h-7V7h7v4z"/></svg>
      </button>
      <button className={btnClass(false)} onClick={() => editor.chain().focus().setHorizontalRule().run()} title="分割线">
        <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M4 11h16v2H4z"/></svg>
      </button>

      {/* 上下文：表格操作按钮 */}
      {isInTable && (
        <>
          <div className={sepClass} />
          {/* 上方插入行 */}
          <button
            className={btnClass(false)}
            onClick={() => editor.chain().focus().addRowBefore().run()}
            title="在上方插入行"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v2h20V6c0-1.1-.9-2-2-2zm0 6H2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V10zM11 17H4v-2h7v2zm0-4H4v-2h7v2zm9 4h-7v-2h7v2zm0-4h-7v-2h7v2z"/><path d="M14 1h-4v2H8v2h2v2h4V5h2V3h-2z" opacity=".6"/></svg>
          </button>
          {/* 下方插入行 */}
          <button
            className={btnClass(false)}
            onClick={() => editor.chain().focus().addRowAfter().run()}
            title="在下方插入行"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v10h20V6c0-1.1-.9-2-2-2zM11 12H4v-2h7v2zm0-4H4V6h7v2zm9 4h-7v-2h7v2zm0-4h-7V6h7v2z"/><path d="M14 19h-4v2H8v2h2v-2h4v2h2v-2h-2z" opacity=".6"/></svg>
          </button>
          {/* 左侧插入列 */}
          <button
            className={btnClass(false)}
            onClick={() => editor.chain().focus().addColumnBefore().run()}
            title="在左侧插入列"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h2V4H6zm4 0v20h10c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H10zm7 11H10v-2h7v2zm0-4H10V9h7v2z"/><path d="M1 14v-4h2V8h2v2h-2v4h2v2H3v-2z" opacity=".6"/></svg>
          </button>
          {/* 右侧插入列 */}
          <button
            className={btnClass(false)}
            onClick={() => editor.chain().focus().addColumnAfter().run()}
            title="在右侧插入列"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M4 4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h10V4H4zm7 11H4v-2h7v2zm0-4H4V9h7v2z"/><path d="M18 4v20h2c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2h-2z"/><path d="M21 14v-4h2V8h2v2h-2v4h2v2h-2v-2z" opacity=".6"/></svg>
          </button>

          <div className={sepClass} />

          {/* 删除行 */}
          <button
            className="p-1.5 rounded text-xs font-medium transition-colors text-orange-500 hover:bg-orange-500/10"
            onClick={() => editor.chain().focus().deleteRow().run()}
            title="删除当前行"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M20 4H4c-1.1 0-2 .9-2 2v2h20V6c0-1.1-.9-2-2-2zm0 6H2v10c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V10zm-8 8H4v-2h8v2z"/><path d="M15 13l-1.41 1.41L15.17 16l-1.58 1.59L15 19l1.59-1.59L18.17 19l1.42-1.41L18 16l1.59-1.59L18.17 13 16.59 14.41z" fill="currentColor"/></svg>
          </button>
          {/* 删除列 */}
          <button
            className="p-1.5 rounded text-xs font-medium transition-colors text-orange-500 hover:bg-orange-500/10"
            onClick={() => editor.chain().focus().deleteColumn().run()}
            title="删除当前列"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 4c-1.1 0-2 .9-2 2v16c0 1.1.9 2 2 2h2V4H6zm4 0v20h10c1.1 0 2-.9 2-2V6c0-1.1-.9-2-2-2H10zm7 7H10V9h7v2z"/><path d="M13 16l-1.41 1.41L13.17 19l-1.58 1.59L13 22l1.59-1.59L16.17 22l1.42-1.41L16 19l1.59-1.59L16.17 16l-1.58 1.41z" fill="currentColor"/></svg>
          </button>
          {/* 删除表格 */}
          <button
            className="p-1.5 rounded text-xs font-medium transition-colors text-red-500 hover:bg-red-500/10"
            onClick={() => editor.chain().focus().deleteTable().run()}
            title="删除表格"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </>
      )}

      {/* 上下文：代码块删除按钮 */}
      {editor.isActive('codeBlock') && (
        <>
          <div className={sepClass} />
          <button
            className="p-1.5 rounded text-xs font-medium transition-colors text-red-500 hover:bg-red-500/10"
            onClick={() => editor.chain().focus().toggleCodeBlock().run()}
            title="删除代码块"
          >
            <svg className="w-4 h-4" viewBox="0 0 24 24" fill="currentColor"><path d="M6 19c0 1.1.9 2 2 2h8c1.1 0 2-.9 2-2V7H6v12zM19 4h-3.5l-1-1h-5l-1 1H5v2h14V4z"/></svg>
          </button>
        </>
      )}
    </div>
  );
}

// ---- 斜杠命令菜单组件 ----
function SlashCommandMenu({
  editor,
  query,
  position,
  onClose,
}: {
  editor: Editor;
  query: string;
  position: { top: number; left: number };
  onClose: () => void;
}) {
  const [selectedIndex, setSelectedIndex] = useState(0);
  const menuRef = useRef<HTMLDivElement>(null);

  const filtered = slashCommands.filter(
    (cmd) =>
      cmd.label.toLowerCase().includes(query.toLowerCase()) ||
      cmd.description.toLowerCase().includes(query.toLowerCase())
  );

  // 重置选中索引
  useEffect(() => {
    setSelectedIndex(0);
  }, [query]);

  // 键盘导航
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filtered.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filtered.length) % filtered.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        if (filtered[selectedIndex]) {
          executeCommand(filtered[selectedIndex]);
        }
      } else if (e.key === 'Escape') {
        e.preventDefault();
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown, true);
    return () => document.removeEventListener('keydown', handleKeyDown, true);
  }, [filtered, selectedIndex, onClose]);

  const executeCommand = (cmd: SlashCommand) => {
    // 删除 / 和查询文本
    editor.chain().focus().deleteRange({
      from: editor.state.selection.from - query.length - 1,
      to: editor.state.selection.from,
    }).run();
    cmd.action(editor);
    onClose();
  };

  if (filtered.length === 0) return null;

  return (
    <div
      ref={menuRef}
      className="slash-command-menu fixed z-[60] bg-popover border border-border rounded-lg shadow-lg py-1 w-56 max-h-64 overflow-y-auto"
      style={{ top: position.top, left: position.left }}
    >
      {filtered.map((cmd, index) => (
        <button
          key={cmd.label}
          className={`w-full flex items-center gap-3 px-3 py-2 text-left text-sm transition-colors ${
            index === selectedIndex ? 'bg-accent text-foreground' : 'text-muted-foreground hover:bg-accent hover:text-foreground'
          }`}
          onClick={() => executeCommand(cmd)}
          onMouseEnter={() => setSelectedIndex(index)}
        >
          <span className="w-6 text-center text-xs font-mono flex-shrink-0">{cmd.icon}</span>
          <div className="flex-1 min-w-0">
            <div className="font-medium">{cmd.label}</div>
            <div className="text-xs text-muted-foreground">{cmd.description}</div>
          </div>
        </button>
      ))}
    </div>
  );
}

// ---- NoteModal 主组件 ----
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
        // 输入 / 时在行首或空内容后触发斜杠命令
        if (event.key === '/' && !slashMenu) {
          // 延迟检测，等字符插入后再判断
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
          // 光标移到了 / 之前，关闭菜单
          setSlashMenu(null);
          slashStartPos.current = null;
        } else {
          const query = editor.state.doc.textBetween(slashStartPos.current, from, '\n');
          if (query.includes(' ') || query.includes('\n')) {
            // 输入了空格或换行，关闭菜单
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
        <Toolbar editor={editor} />

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
