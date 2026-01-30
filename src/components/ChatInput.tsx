'use client';

import { useState, useEffect, useRef, KeyboardEvent, ClipboardEvent, useCallback } from 'react';
import { ImageInfo } from '@/types/chat';
import { ImagePreview } from './ImagePreview';

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
  onReloadHistory?: () => void;
}

export function ChatInput({ onSend, disabled, cwd, onReloadHistory }: ChatInputProps) {
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [showCommands, setShowCommands] = useState(false);
  const [filteredCommands, setFilteredCommands] = useState<CommandInfo[]>([]);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

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

    // 普通发送
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      handleSend();
    }
  };

  const handlePaste = useCallback((e: ClipboardEvent<HTMLTextAreaElement>) => {
    const items = e.clipboardData?.items;
    if (!items) return;

    for (const item of Array.from(items)) {
      // 仅支持 PNG 格式
      if (item.type === 'image/png') {
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

          const newImage: ImageInfo = {
            id: `img-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
            data: dataUrl.replace('data:image/png;base64,', ''),
            preview: dataUrl,
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
        return 'bg-blue-100 text-blue-700 dark:bg-blue-900 dark:text-blue-300';
      case 'global':
        return 'bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300';
      case 'project':
        return 'bg-purple-100 text-purple-700 dark:bg-purple-900 dark:text-purple-300';
    }
  };

  return (
    <div className="border-t border-gray-200 dark:border-gray-700 bg-white dark:bg-gray-800 relative">
      <ImagePreview images={images} onRemove={handleRemoveImage} disabled={disabled} />

      {/* 命令候选列表 */}
      {showCommands && filteredCommands.length > 0 && (
        <div
          ref={commandListRef}
          className="absolute bottom-full left-0 right-0 mx-4 mb-2 max-h-64 overflow-y-auto bg-white dark:bg-gray-800 border border-gray-200 dark:border-gray-600 rounded-lg shadow-lg"
        >
          {filteredCommands.map((cmd, index) => (
            <div
              key={cmd.name}
              onClick={() => handleSelectCommand(cmd)}
              className={`flex items-center gap-3 px-4 py-2 cursor-pointer ${
                index === selectedIndex
                  ? 'bg-blue-50 dark:bg-blue-900/30'
                  : 'hover:bg-gray-50 dark:hover:bg-gray-700'
              }`}
            >
              <span className="font-mono text-sm font-medium text-gray-900 dark:text-gray-100">
                {cmd.name}
              </span>
              <span className="flex-1 text-sm text-gray-500 dark:text-gray-400 truncate">
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
        {/* 刷新历史按钮 */}
        {onReloadHistory && (
          <button
            onClick={onReloadHistory}
            disabled={disabled}
            className="p-2 text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200 hover:bg-gray-100 dark:hover:bg-gray-700 active:bg-gray-200 dark:active:bg-gray-600 active:scale-95 rounded-lg transition-all disabled:opacity-50"
            title="重新加载历史消息"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
            </svg>
          </button>
        )}
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder="输入消息，Enter 发送 (Shift+Enter 换行，可粘贴 PNG 图片，/ 显示命令)"
          disabled={disabled}
          rows={1}
          className="flex-1 resize-none px-4 py-2 border border-gray-300 dark:border-gray-600 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500 bg-white dark:bg-gray-700 text-gray-900 dark:text-gray-100 placeholder-gray-400 dark:placeholder-gray-500 disabled:opacity-50"
        />
      </div>
    </div>
  );
}
