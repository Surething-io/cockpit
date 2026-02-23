'use client';

import { useState, useEffect, useRef, KeyboardEvent, ClipboardEvent, useCallback } from 'react';
import { ImageInfo } from '@/types/chat';
import { ImagePreview } from '../shared/ImagePreview';
import { toast } from '../shared/Toast';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

interface CommandInfo {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project';
}

interface ChatInputProps {
  onSend: (message: string, images?: ImageInfo[]) => void;
  disabled?: boolean;
  cwd?: string;
  onShowGitStatus?: () => void;
  onShowComments?: () => void;
  onShowUserMessages?: () => void;
  onOpenNote?: () => void;
}

export function ChatInput({ onSend, disabled, cwd, onShowGitStatus, onShowComments, onShowUserMessages, onOpenNote }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<CommandInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

  // 自动调整 textarea 高度
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // 重置高度以获取正确的 scrollHeight
    textarea.style.height = 'auto';
    // 设置新高度，最小 38px（单行），最大 200px（约 8-10 行）
    const minHeight = 38;
    const maxHeight = 200;
    const newHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${newHeight}px`;
  }, []);

  // 当输入内容变化时调整高度
  useEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // 加载命令列表
  useEffect(() => {
    const loadCommands = async () => {
      try {
        const url = cwd ? `/api/commands?cwd=${encodeURIComponent(cwd)}` : '/api/commands';
        const response = await fetch(url);
        if (response.ok) {
          const data = await response.json();
          setCommands(data);
        }
      } catch (error) {
        console.error('Failed to load commands:', error);
      }
    };
    loadCommands();
  }, [cwd]);

  // 监听输入变化，检测是否需要显示命令列表
  useEffect(() => {
    if (input.startsWith('/')) {
      const keyword = input.toLowerCase();
      const filtered = commands.filter((cmd) =>
        cmd.name.toLowerCase().startsWith(keyword)
      );
      setFilteredCommands(filtered);
      setShowCommands(filtered.length > 0);
      setSelectedIndex(0);
    } else {
      setShowCommands(false);
    }
  }, [input, commands]);

  // 滚动选中项到可视区域
  useEffect(() => {
    if (showCommands && commandListRef.current) {
      const selectedItem = commandListRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showCommands]);

  const handleSend = () => {
    const trimmed = input.trim();
    const hasContent = trimmed || images.length > 0;

    if (hasContent && !disabled) {
      onSend(trimmed, images.length > 0 ? images : undefined);
      setInput('');
      setImages([]);
      setShowCommands(false);
      // 重置 textarea 高度
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  };

  const handleSelectCommand = (command: CommandInfo) => {
    setInput(command.name + ' ');
    setShowCommands(false);
    textareaRef.current?.focus();
  };

  const handleKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    // 检查是否正在进行输入法组合输入（如中文拼音输入）
    if (e.nativeEvent.isComposing) {
      return;
    }

    // 命令列表键盘导航
    if (showCommands && filteredCommands.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev + 1) % filteredCommands.length);
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((prev) => (prev - 1 + filteredCommands.length) % filteredCommands.length);
        return;
      }
      if (e.key === 'Enter') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[selectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowCommands(false);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[selectedIndex]);
        return;
      }
    }

    // 普通发送（排除 IME 组合状态）
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    const supportedTypes = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const;

    for (const item of Array.from(items)) {
      const mediaType = supportedTypes.find((t) => item.type === t);
      if (mediaType) {
        e.preventDefault();

        const file = item.getAsFile();
        if (!file) continue;

        // 检查文件大小
        if (file.size > MAX_IMAGE_SIZE) {
          alert(`图片大小超过限制（最大 5MB），当前大小: ${(file.size / 1024 / 1024).toFixed(2)}MB`);
          continue;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string;
          if (!dataUrl) return;

          // 从 data URL 中提取 base64 部分（兼容所有 MIME 类型）
          const base64Data = dataUrl.replace(/^data:image\/\w+;base64,/, '');

          const newImage: ImageInfo = {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            data: base64Data,
            preview: dataUrl,
            media_type: mediaType,
          };

          setImages((prev) => [...prev, newImage]);
        };
        reader.readAsDataURL(file);
      }
    }
  }, []);

  const handleRemoveImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const getSourceLabel = (source: CommandInfo['source']) => {
    switch (source) {
      case 'builtin':
        return '内置';
      case 'global':
        return '全局';
      case 'project':
        return '项目';
    }
  };

  const getSourceColor = (source: CommandInfo['source']) => {
    switch (source) {
      case 'builtin':
        return 'bg-brand/15 text-brand dark:bg-brand/25 dark:text-teal-11';
      case 'global':
        return 'bg-green-9/15 text-green-11 dark:bg-green-9/25 dark:text-green-11';
      case 'project':
        return 'bg-amber-9/15 text-amber-11 dark:bg-amber-9/25 dark:text-amber-11';
    }
  };

  return (
    <div className="border-t border-border bg-card relative">
      <ImagePreview images={images} onRemove={handleRemoveImage} disabled={disabled} />

      {/* 命令候选列表 */}
      {showCommands && filteredCommands.length > 0 && (
        <div
          ref={commandListRef}
          className="absolute bottom-full left-0 right-0 mx-4 mb-2 max-h-64 overflow-y-auto bg-card border border-border rounded-lg shadow-lg"
        >
          {filteredCommands.map((cmd, index) => (
            <div
              key={cmd.name}
              onClick={() => handleSelectCommand(cmd)}
              className={`flex items-center gap-3 px-4 py-2 cursor-pointer ${
                index === selectedIndex
                  ? 'bg-brand/10'
                  : 'hover:bg-accent'
              }`}
            >
              <span className="font-mono text-sm font-medium text-foreground">
                {cmd.name}
              </span>
              <span className="flex-1 text-sm text-muted-foreground truncate">
                {cmd.description}
              </span>
              <span
                className={`text-xs px-1.5 py-0.5 rounded ${getSourceColor(cmd.source)}`}
              >
                {getSourceLabel(cmd.source)}
              </span>
            </div>
          ))}
        </div>
      )}

      <div className="flex gap-2 items-end p-4">
        {/* Git 暂存所有文件按钮 */}
        <button
          onClick={async () => {
            try {
              const response = await fetch('/api/git/stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, files: ['.'] }),
              });
              if (response.ok) {
                toast('已暂存所有文件', 'success');
                window.dispatchEvent(new CustomEvent('git-status-changed'));
              } else {
                toast('暂存失败', 'error');
              }
            } catch (err) {
              console.error('Error staging files:', err);
              toast('暂存失败', 'error');
            }
          }}
          className="p-2 text-green-11 hover:text-green-10 hover:bg-green-9/10 active:bg-green-9/20 active:scale-95 rounded-lg transition-all"
          title="暂存所有文件 (git add -A)"
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>

        {/* Git 查看变更按钮 - 生成中也可点击 */}
        {onShowGitStatus && (
          <button
            onClick={onShowGitStatus}
            className="p-2 text-brand hover:text-teal-10 hover:bg-brand/10 active:bg-brand/20 active:scale-95 rounded-lg transition-all"
            title="查看 Git 变更"
          >
            {/* Git 分支图标 */}
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="6" cy="6" r="2" strokeWidth={2} />
              <circle cx="18" cy="6" r="2" strokeWidth={2} />
              <circle cx="6" cy="18" r="2" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 8v10M18 8v4c0 2-2 4-6 4" />
            </svg>
          </button>
        )}

        {/* 查看评论按钮 */}
        {onShowComments && (
          <button
            onClick={onShowComments}
            className="p-2 text-amber-11 hover:text-amber-10 hover:bg-amber-9/10 active:bg-amber-9/20 active:scale-95 rounded-lg transition-all"
            title="查看所有评论"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
          </button>
        )}

        {/* 用户消息列表按钮 */}
        {onShowUserMessages && (
          <button
            onClick={onShowUserMessages}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="用户消息列表"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}

        {/* 项目笔记按钮 */}
        {onOpenNote && (
          <button
            onClick={onOpenNote}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="项目笔记"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? "生成中... 可继续输入" : "输入消息，Enter 发送 (Shift+Enter 换行，可粘贴图片，/ 显示命令)"}
          rows={1}
          className="flex-1 resize-none px-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring bg-card text-foreground placeholder-slate-9"
        />
      </div>

    </div>
  );
}
