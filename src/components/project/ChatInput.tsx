'use client';

import { useState, useEffect, useLayoutEffect, useRef, KeyboardEvent, ClipboardEvent, useCallback, useMemo, memo } from 'react';
import { ImageInfo } from '@/types/chat';
import type { ChatEngine } from './useTabState';
import { ImagePreview } from '../shared/ImagePreview';
import { toast } from '../shared/Toast';
import { ScheduleTaskPopover } from './ScheduleTaskPopover';
import { useTranslation } from 'react-i18next';
import { onSkillsChanged } from '@/lib/skills/skillsBus';

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

interface CommandInfo {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project' | 'skill';
  // Only present when source === 'skill'
  skillPath?: string;
  argumentHint?: string;
}

interface SkillInfo {
  id: string;
  path: string;
  name: string;
  description: string;
  icon?: string;
  argumentHint?: string;
  valid: boolean;
}

interface ChatInputProps {
  onSend: (message: string, images?: ImageInfo[]) => void;
  disabled?: boolean;
  cwd?: string;
  engine?: ChatEngine;
  onShowGitStatus?: () => void;
  onShowComments?: () => void;
  onShowUserMessages?: () => void;
  onOpenNote?: () => void;
  onCreateScheduledTask?: (params: {
    message: string;
    type: 'once' | 'interval' | 'cron';
    delayMinutes?: number;
    intervalMinutes?: number;
    activeFrom?: string;
    activeTo?: string;
    cron?: string;
  }) => void;
}

export const ChatInput = memo(function ChatInput({ onSend, disabled, cwd, engine, onShowGitStatus, onShowComments, onShowUserMessages, onOpenNote, onCreateScheduledTask }: ChatInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [commands, setCommands] = useState<CommandInfo[]>([]);
  const [skills, setSkills] = useState<CommandInfo[]>([]);
  const [showScheduler, setShowScheduler] = useState(false);
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [commandsDismissed, setCommandsDismissed] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const commandListRef = useRef<HTMLDivElement>(null);

  // Auto-adjust textarea height
  const adjustTextareaHeight = useCallback(() => {
    const textarea = textareaRef.current;
    if (!textarea) return;

    // Reset height to get the correct scrollHeight
    textarea.style.height = 'auto';
    // Set new height: min 38px (single line), max 200px (approx 8-10 lines)
    const minHeight = 38;
    const maxHeight = 200;
    const newHeight = Math.max(minHeight, Math.min(textarea.scrollHeight, maxHeight));
    textarea.style.height = `${newHeight}px`;
  }, []);

  // Adjust height when input changes (useLayoutEffect: runs synchronously before paint to avoid double-paint flicker)
  useLayoutEffect(() => {
    adjustTextareaHeight();
  }, [input, adjustTextareaHeight]);

  // Load command list
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

  // Load skills (separate endpoint, globally-configured, ~/.cockpit/skills.json)
  const loadSkills = useCallback(async () => {
    try {
      const response = await fetch('/api/skills');
      if (response.ok) {
        const data = (await response.json()) as SkillInfo[];
        const mapped: CommandInfo[] = data
          .filter((s) => s.valid && !!s.name)
          .map((s) => ({
            name: `/${s.name}`,
            description: s.description || '',
            source: 'skill' as const,
            skillPath: s.path,
            argumentHint: s.argumentHint,
          }));
        setSkills(mapped);
      }
    } catch (error) {
      console.error('Failed to load skills:', error);
    }
  }, []);

  useEffect(() => {
    loadSkills();
    // Re-load when SkillsModal notifies the skills list changed
    return onSkillsChanged(loadSkills);
  }, [loadSkills]);

  // Command filtering: useMemo derived computation, eliminates 3 setState calls per keystroke
  // Commands first, then skills — grouped display preserves the two sections.
  const filteredCommands = useMemo(() => {
    if (!input.startsWith('/')) return [];
    const keyword = input.toLowerCase();
    const match = (cmd: CommandInfo) => cmd.name.toLowerCase().startsWith(keyword);
    return [...commands.filter(match), ...skills.filter(match)];
  }, [input, commands, skills]);

  const showCommands = !commandsDismissed && input.startsWith('/') && filteredCommands.length > 0;

  // Reset selected index and dismiss state when input changes
  const prevInputRef = useRef(input);
  useLayoutEffect(() => {
    if (prevInputRef.current !== input) {
      queueMicrotask(() => setSelectedIndex(0));
      if (commandsDismissed) queueMicrotask(() => setCommandsDismissed(false));
      prevInputRef.current = input;
    }
  }, [input, commandsDismissed]);

  // Scroll selected item into view
  useLayoutEffect(() => {
    if (showCommands && commandListRef.current) {
      const selectedItem = commandListRef.current.children[selectedIndex] as HTMLElement;
      if (selectedItem) {
        selectedItem.scrollIntoView({ block: 'nearest' });
      }
    }
  }, [selectedIndex, showCommands]);

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    const hasContent = trimmed || images.length > 0;

    if (hasContent && !disabled) {
      // Expand leading /<skill-name> into "请读取这个 skill 文件：<abs path>\n\n<rest>"
      let finalMessage = trimmed;
      if (trimmed.startsWith('/') && skills.length > 0) {
        // Longest-name-first match to handle overlapping prefixes (e.g. /foo vs /foo-bar)
        const sorted = [...skills].sort((a, b) => b.name.length - a.name.length);
        for (const skill of sorted) {
          if (!skill.skillPath) continue;
          if (trimmed === skill.name) {
            finalMessage = `${t('chat.skillExpansionPrompt')}\n${skill.skillPath}`;
            break;
          }
          const prefix = `${skill.name} `;
          if (trimmed.startsWith(prefix)) {
            const rest = trimmed.slice(prefix.length).trimStart();
            finalMessage = `${t('chat.skillExpansionPrompt')}\n${skill.skillPath}\n\n${rest}`;
            break;
          }
        }
      }
      onSend(finalMessage, images.length > 0 ? images : undefined);
      setInput('');
      setImages([]);
      // Reset textarea height
      if (textareaRef.current) {
        textareaRef.current.style.height = 'auto';
      }
    }
  }, [input, images, disabled, onSend, skills, t]);

  const handleSelectCommand = useCallback((command: CommandInfo) => {
    setInput(command.name + ' ');
    textareaRef.current?.focus();
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Check if IME composition is in progress (e.g., Chinese pinyin input)
    if (e.nativeEvent.isComposing) {
      return;
    }

    // Command list keyboard navigation
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
        setCommandsDismissed(true);
        return;
      }
      if (e.key === 'Tab') {
        e.preventDefault();
        handleSelectCommand(filteredCommands[selectedIndex]);
        return;
      }
    }

    // Normal send (excluding IME composition state)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [showCommands, filteredCommands, selectedIndex, handleSelectCommand, handleSend]);

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

        // Check file size
        if (file.size > MAX_IMAGE_SIZE) {
          alert(t('chat.imageSizeLimit', { size: (file.size / 1024 / 1024).toFixed(2) }));
          continue;
        }

        const reader = new FileReader();
        reader.onload = (event) => {
          const dataUrl = event.target?.result as string;
          if (!dataUrl) return;

          // Extract base64 portion from data URL (compatible with all MIME types)
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
  }, [t]);

  const handleRemoveImage = useCallback((id: string) => {
    setImages((prev) => prev.filter((img) => img.id !== id));
  }, []);

  const getSourceLabel = (source: CommandInfo['source']) => {
    switch (source) {
      case 'builtin':
        return t('common.builtin');
      case 'global':
        return t('common.global');
      case 'project':
        return t('common.project');
      case 'skill':
        return 'Skill';
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
      case 'skill':
        return 'bg-purple-9/15 text-purple-11 dark:bg-purple-9/25 dark:text-purple-11';
    }
  };

  return (
    <div className="border-t border-border bg-card relative">
      <ImagePreview images={images} onRemove={handleRemoveImage} disabled={disabled} />

      {/* Command candidate list */}
      {showCommands && filteredCommands.length > 0 && (
        <div
          ref={commandListRef}
          className="absolute bottom-full left-0 right-0 mx-4 mb-2 max-h-64 overflow-y-auto bg-card border border-border rounded-lg shadow-lg"
        >
          {filteredCommands.map((cmd, index) => {
            const prev = index > 0 ? filteredCommands[index - 1] : null;
            const isFirstSkill = cmd.source === 'skill' && (!prev || prev.source !== 'skill');
            const isFirstCommand = cmd.source !== 'skill' && index === 0;
            return (
              <div key={cmd.name}>
                {isFirstCommand && (
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                    Commands
                  </div>
                )}
                {isFirstSkill && (
                  <div className="px-4 py-1 text-[10px] uppercase tracking-wider text-muted-foreground bg-muted/40">
                    Skills
                  </div>
                )}
                <div
                  onClick={() => handleSelectCommand(cmd)}
                  className={`px-4 py-2 cursor-pointer ${
                    index === selectedIndex
                      ? 'bg-brand/10'
                      : 'hover:bg-accent'
                  }`}
                >
                  <div className="flex items-center gap-3">
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
                  {cmd.source === 'skill' && cmd.argumentHint && (
                    <div className="font-mono text-xs text-muted-foreground mt-0.5 pl-0 truncate">
                      {cmd.argumentHint}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="flex gap-2 items-end p-4">
        {/* Git stage all files button */}
        <button
          onClick={async () => {
            try {
              const response = await fetch('/api/git/stage', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ cwd, files: ['.'] }),
              });
              if (response.ok) {
                toast(t('toast.stagedAllFiles'), 'success');
                window.dispatchEvent(new CustomEvent('git-status-changed'));
              } else {
                toast(t('toast.stageFailed'), 'error');
              }
            } catch (err) {
              console.error('Error staging files:', err);
              toast(t('toast.stageFailed'), 'error');
            }
          }}
          className="p-2 text-green-11 hover:text-green-10 hover:bg-green-9/10 active:bg-green-9/20 active:scale-95 rounded-lg transition-all"
          title={t('chat.stageAll')}
        >
          <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>

        {/* Git view changes button - clickable even during generation */}
        {onShowGitStatus && (
          <button
            onClick={onShowGitStatus}
            className="p-2 text-brand hover:text-teal-10 hover:bg-brand/10 active:bg-brand/20 active:scale-95 rounded-lg transition-all"
            title={t('chat.viewGitChanges')}
          >
            {/* Git branch icon */}
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="6" cy="6" r="2" strokeWidth={2} />
              <circle cx="18" cy="6" r="2" strokeWidth={2} />
              <circle cx="6" cy="18" r="2" strokeWidth={2} />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 8v10M18 8v4c0 2-2 4-6 4" />
            </svg>
          </button>
        )}

        {/* View comments button */}
        {onShowComments && (
          <button
            onClick={onShowComments}
            className="p-2 text-amber-11 hover:text-amber-10 hover:bg-amber-9/10 active:bg-amber-9/20 active:scale-95 rounded-lg transition-all"
            title={t('chat.viewAllComments')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
          </button>
        )}

        {/* User messages list button */}
        {onShowUserMessages && (
          <button
            onClick={onShowUserMessages}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title={t('chat.userMessages')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
            </svg>
          </button>
        )}

        {/* Project notes button */}
        {onOpenNote && (
          <button
            onClick={onOpenNote}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title={t('chat.projectNotes')}
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        )}

        {/* Scheduled task button */}
        {onCreateScheduledTask && (
          <div className="relative">
            <button
              onClick={() => setShowScheduler(!showScheduler)}
              className={`p-2 rounded-lg transition-all ${
                showScheduler
                  ? 'text-brand bg-brand/10'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95'
              }`}
              title={t('chat.scheduledTasks')}
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 6v6l4 2" />
              </svg>
            </button>
            {showScheduler && (
              <ScheduleTaskPopover
                onClose={() => setShowScheduler(false)}
                onCreate={onCreateScheduledTask}
              />
            )}
          </div>
        )}

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? t('chat.placeholderDisabled') : t('chat.placeholder')}
          rows={1}
          className="flex-1 resize-none px-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring bg-card text-foreground placeholder-slate-9"
        />
      </div>

    </div>
  );
});
