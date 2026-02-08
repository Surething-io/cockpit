'use client';

import { useState, useEffect, useRef } from 'react';
import { Editor } from '@tiptap/react';
import { slashCommands, type SlashCommand } from './slashCommands';

// ============================================
// 斜杠命令菜单组件
// ============================================

interface SlashCommandMenuProps {
  editor: Editor;
  query: string;
  position: { top: number; left: number };
  onClose: () => void;
}

export function SlashCommandMenu({ editor, query, position, onClose }: SlashCommandMenuProps) {
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

  const executeCommand = (cmd: SlashCommand) => {
    // 删除 / 和查询文本
    editor.chain().focus().deleteRange({
      from: editor.state.selection.from - query.length - 1,
      to: editor.state.selection.from,
    }).run();
    cmd.action(editor);
    onClose();
  };

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
