'use client';

import { useState, useLayoutEffect, useRef, KeyboardEvent, ClipboardEvent, useCallback, useMemo, memo } from 'react';
import type { ImageInfo, ChatEngine } from './types';
import { useTranslation } from 'react-i18next';
import { ImagePreview } from '@cockpit/shared-ui';
import { ScheduleTaskPopover } from './ScheduleTaskPopover';
import { QuickPromptsPopover } from './QuickPromptsPopover';
import { useCommandAutocomplete, CommandAutocompleteMenu, type CommandInfo } from './commandAutocomplete';

// Migrated from src/components/project/ChatInput.tsx.

const MAX_IMAGE_SIZE = 5 * 1024 * 1024; // 5MB

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

export const ChatInput = memo(function ChatInput({ onSend, disabled, cwd, engine: _engine, onShowGitStatus, onShowComments, onShowUserMessages, onOpenNote, onCreateScheduledTask }: ChatInputProps) {
  const { t } = useTranslation();
  const [input, setInput] = useState('');
  const [images, setImages] = useState<ImageInfo[]>([]);
  const [showScheduler, setShowScheduler] = useState(false);
  const [showQuickPrompts, setShowQuickPrompts] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  // Wraps the quick-prompts trigger + its popover; the popover measures
  // outside-click against this so the trigger can close what it opened.
  const quickPromptsAnchorRef = useRef<HTMLDivElement>(null);

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

  // Client-side commands that perform a UI action instead of expanding to a prompt.
  // `/plan` toggles plan mode (consumed in Chat.wrappedHandleSend) — only on claude engines.
  const localCommands = useMemo<CommandInfo[]>(() => {
    const isClaude = !_engine || _engine === 'claude';
    if (!isClaude) return [];
    return [{
      name: '/plan',
      description: 'Enable plan mode (read-only). /plan <task> to plan a task; /plan off to disable.',
      source: 'builtin',
      argumentHint: '[task|off]',
    }];
  }, [_engine]);

  const commandAutocomplete = useCommandAutocomplete({
    value: input,
    onChange: setInput,
    textareaRef,
    extraCommands: localCommands,
  });

  const handleSend = useCallback(() => {
    const trimmed = input.trim();
    const hasContent = trimmed || images.length > 0;
    if (!hasContent || disabled) return;

    // Slash/at commands (/qa, @new-branch, user skills, multi-line) are resolved
    // server-side by resolveCommandPrompt — send the raw text so the displayed
    // message stays readable and a single resolver handles builtins + skills +
    // sequential multi-command.
    onSend(trimmed, images.length > 0 ? images : undefined);
    setInput('');
    setImages([]);
    // Reset textarea height
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
    }
  }, [input, images, disabled, onSend]);

  // Quick prompts send immediately and bypass `input` entirely, so whatever the
  // user has half-typed in the textarea is left untouched. Gated on `disabled`
  // for the same reason handleSend is — the stream can't accept it yet.
  const handleQuickPrompt = useCallback((prompt: string) => {
    if (disabled) return;
    onSend(prompt);
  }, [disabled, onSend]);

  // "Fill the box, don't send." APPENDS rather than replaces — the use case is
  // stacking a canned prompt onto something half-typed, and a silent overwrite
  // would eat that. NOT gated on `disabled`: this issues no request, and queueing
  // up the next message while a reply streams is exactly when it is wanted.
  const handleInsertQuickPrompt = useCallback((prompt: string) => {
    setInput((prev) => {
      // trimEnd first, THEN test: a box holding only whitespace is "empty" here,
      // and testing `prev` raw would prefix the prompt with a stray newline.
      const head = prev.replace(/\s+$/, '');
      return head ? `${head}\n${prompt}` : prompt;
    });
    // rAF, not a direct call: the popover unmounts in this same commit and the
    // caret must be set against the post-update value, not the pre-update one.
    requestAnimationFrame(() => {
      const ta = textareaRef.current;
      if (!ta) return;
      ta.focus();
      ta.setSelectionRange(ta.value.length, ta.value.length);
    });
  }, []);

  const handleKeyDown = useCallback((e: KeyboardEvent<HTMLTextAreaElement>) => {
    // Check if IME composition is in progress (e.g., Chinese pinyin input)
    if (e.nativeEvent.isComposing) {
      return;
    }

    // Command list keyboard navigation takes precedence over send.
    if (commandAutocomplete.handleKeyDown(e)) return;

    // Normal send (excluding IME composition state)
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault();
      handleSend();
    }
  }, [commandAutocomplete, handleSend]);

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

  return (
    <div className="border-t border-border bg-card relative">
      <ImagePreview images={images} onRemove={handleRemoveImage} disabled={disabled} />

      {/* Command candidate list */}
      <CommandAutocompleteMenu
        ac={commandAutocomplete}
        className="absolute bottom-full left-0 right-0 mx-4 mb-2 max-h-64"
      />

      <div className="flex gap-2 items-end p-4">
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
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-hover active:bg-muted active:scale-95 rounded-lg transition-all"
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
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-hover active:bg-muted active:scale-95 rounded-lg transition-all"
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
                  : 'text-muted-foreground hover:text-foreground hover:bg-hover active:bg-muted active:scale-95'
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

        {/* Quick prompts button */}
        <div className="relative" ref={quickPromptsAnchorRef}>
          <button
            onClick={() => setShowQuickPrompts(!showQuickPrompts)}
            className={`p-2 rounded-lg transition-all ${
              showQuickPrompts
                ? 'text-brand bg-brand/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-hover active:bg-muted active:scale-95'
            }`}
            title={t('chat.quickPrompts')}
          >
            {/* Lightning bolt — mirrors the Console input bar's quick commands button */}
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
          </button>
          {showQuickPrompts && (
            <QuickPromptsPopover
              cwd={cwd}
              anchorRef={quickPromptsAnchorRef}
              onClose={() => setShowQuickPrompts(false)}
              onSelect={handleQuickPrompt}
              onInsert={handleInsertQuickPrompt}
            />
          )}
        </div>

        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => {
            setInput(e.target.value);
            commandAutocomplete.trackCaret(e.target);
          }}
          onSelect={(e) => commandAutocomplete.trackCaret(e.currentTarget)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          placeholder={disabled ? t('chat.placeholderDisabled') : t('chat.placeholder')}
          rows={1}
          className="flex-1 resize-none px-4 py-2 border border-border rounded-lg focus:outline-none focus:ring-2 focus:ring-ring bg-card text-foreground"
        />
      </div>

    </div>
  );
});
