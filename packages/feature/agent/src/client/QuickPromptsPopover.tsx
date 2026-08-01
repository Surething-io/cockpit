'use client';

import { useState, useEffect, useCallback } from 'react';
import type { KeyboardEvent as ReactKeyboardEvent, DragEvent as ReactDragEvent, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { Plus, X, Pencil, Send, GripVertical } from 'lucide-react';
import { Tooltip } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadGlobalPromptsConfig,
  loadProjectPromptsConfig,
  savePromptsConfig,
} from './effect/agentClient';

interface QuickPromptsPopoverProps {
  /** Undefined when no project is open — the project section is then hidden. */
  cwd?: string;
  /**
   * Wrapper that holds BOTH the trigger button and this popover. Outside-click
   * is measured against it, not against the popover alone: a mousedown on the
   * trigger would otherwise close the popover, and the button's own onClick —
   * running one task later, against the already-updated state — would toggle it
   * straight back open, making the trigger unable to close what it opened.
   */
  anchorRef: RefObject<HTMLElement | null>;
  onClose: () => void;
  /** Fires with the prompt text; the caller sends it. */
  onSelect: (prompt: string) => void;
}

/**
 * Single-line editor used for both "add" and "edit" — the two differ only in
 * their initial value, so one component keeps the Enter/Escape/IME handling in
 * exactly one place.
 */
function PromptEditor({
  initialValue,
  placeholder,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  placeholder: string;
  onCommit: (value: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    // isComposing guard: Enter while an IME candidate window is open commits the
    // candidate, it does not mean "save".
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      const trimmed = value.trim();
      if (trimmed) onCommit(trimmed);
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }, [value, onCommit, onCancel]);

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => setValue(e.target.value)}
      onKeyDown={handleKeyDown}
      placeholder={placeholder}
      autoFocus
      className="w-full min-w-0 px-2 py-1 mb-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
    />
  );
}

/** Prompt list for one scope (global / project). */
function PromptSection({
  label,
  prompts,
  isAdding,
  onStartAdd,
  onCancelAdd,
  onAdd,
  onUpdate,
  onDelete,
  onReorder,
  onSelect,
}: {
  label: string;
  prompts: string[];
  isAdding: boolean;
  onStartAdd: () => void;
  onCancelAdd: () => void;
  onAdd: (prompt: string) => void;
  onUpdate: (index: number, prompt: string) => void;
  onDelete: (index: number) => void;
  onReorder: (prompts: string[]) => void;
  onSelect: (prompt: string) => void;
}) {
  const { t } = useTranslation();
  const [editIndex, setEditIndex] = useState<number | null>(null);
  const [dragIndex, setDragIndex] = useState<number | null>(null);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);

  const clearDrag = useCallback(() => {
    setDragIndex(null);
    setDragOverIndex(null);
  }, []);

  const handleDragOver = useCallback((e: ReactDragEvent, index: number) => {
    e.preventDefault();
    setDragOverIndex(index);
  }, []);

  const handleDrop = useCallback((index: number) => {
    if (dragIndex === null || dragIndex === index) {
      clearDrag();
      return;
    }
    const next = [...prompts];
    const [moved] = next.splice(dragIndex, 1);
    next.splice(index, 0, moved);
    clearDrag();
    // An open editor is addressed by index; a reorder underneath it would make
    // the pending save land on whichever prompt now occupies that slot.
    setEditIndex(null);
    onReorder(next);
  }, [dragIndex, prompts, onReorder, clearDrag]);

  return (
    <div className="p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground px-1">{label}</span>
        <button
          type="button"
          onClick={() => { setEditIndex(null); onStartAdd(); }}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded"
          title={t('chat.addQuickPrompt')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {isAdding && (
        <PromptEditor
          initialValue=""
          placeholder={t('chat.quickPromptPlaceholder')}
          onCommit={onAdd}
          onCancel={onCancelAdd}
        />
      )}

      {prompts.length === 0 && !isAdding && (
        <div className="text-xs text-muted-foreground px-1 py-1">{t('chat.noQuickPrompts')}</div>
      )}

      {prompts.map((prompt, i) =>
        editIndex === i ? (
          <PromptEditor
            key={`edit-${i}`}
            initialValue={prompt}
            placeholder={t('chat.quickPromptPlaceholder')}
            onCommit={(value) => { setEditIndex(null); onUpdate(i, value); }}
            onCancel={() => setEditIndex(null)}
          />
        ) : (
          // draggable sits on the row, not the grip: the grip is only an
          // affordance, and a drag started anywhere on the row still works.
          <div
            key={i}
            draggable
            onDragStart={() => setDragIndex(i)}
            onDragOver={(e) => handleDragOver(e, i)}
            onDrop={() => handleDrop(i)}
            onDragEnd={clearDrag}
            className={`flex items-center group min-w-0 rounded transition-opacity ${
              dragIndex === i ? 'opacity-50' : ''
            } ${dragOverIndex === i && dragIndex !== i ? 'border-t-2 border-brand' : ''}`}
          >
            <GripVertical className="w-3 h-3 flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity cursor-grab" />
            {/* Tooltip wraps only this button, not the whole row. TooltipProvider
                resolves it by walking UP the parent chain, so hosting it on the
                row would make hovering the icon buttons below surface the prompt
                tooltip AND their own native `title` bubble at once. Cloned onto
                the button (no className), so `flex-1` and layout are untouched. */}
            <Tooltip content={prompt}>
              <button
                type="button"
                onClick={() => onSelect(prompt)}
                className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-accent transition-colors"
              >
                <Send className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{prompt}</span>
              </button>
            </Tooltip>
            {/* Icon-only: `title` stays as the sole accessible name, per the
                tooltip migration's own carve-out for unlabelled buttons. */}
            <button
              type="button"
              onClick={() => setEditIndex(i)}
              className="p-1 text-muted-foreground hover:text-foreground rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              title={t('common.edit')}
            >
              <Pencil className="w-3 h-3" />
            </button>
            <button
              type="button"
              onClick={() => { setEditIndex(null); onDelete(i); }}
              className="p-1 text-muted-foreground hover:text-destructive rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              title={t('common.delete')}
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        )
      )}
    </div>
  );
}

export function QuickPromptsPopover({ cwd, anchorRef, onClose, onSelect }: QuickPromptsPopoverProps) {
  const { t } = useTranslation();
  const [globalPrompts, setGlobalPrompts] = useState<string[]>([]);
  const [projectPrompts, setProjectPrompts] = useState<string[]>([]);
  const [addingSection, setAddingSection] = useState<'global' | 'project' | null>(null);

  // Mounted only while open (parent renders conditionally), so this is the
  // open-time load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [globalExit, projectExit] = await Promise.all([
        BrowserRuntime.runPromiseExit(loadGlobalPromptsConfig()),
        cwd ? BrowserRuntime.runPromiseExit(loadProjectPromptsConfig(cwd)) : null,
      ]);
      if (cancelled) return;
      if (globalExit._tag === 'Success') setGlobalPrompts(globalExit.value.prompts ?? []);
      else console.error('Failed to load global prompts:', globalExit.cause);
      if (projectExit && projectExit._tag === 'Success') setProjectPrompts(projectExit.value.prompts ?? []);
      else if (projectExit) console.error('Failed to load project prompts:', projectExit.cause);
    })();
    return () => { cancelled = true; };
  }, [cwd]);

  // Close on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      const root = anchorRef.current;
      if (root && !root.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [anchorRef, onClose]);

  // Optimistic update, then RECONCILE with what the server actually persisted:
  // POST normalizes (trims, drops empties, collapses duplicates), so keeping the
  // optimistic array would leave the popover disagreeing with disk — and the
  // next edit would write the stale list straight back.
  const savePrompts = useCallback(async (
    scope: 'global' | 'project',
    prompts: string[]
  ) => {
    const setLocal = scope === 'global' ? setGlobalPrompts : setProjectPrompts;
    setLocal(prompts);
    const exit = await BrowserRuntime.runPromiseExit(
      savePromptsConfig(scope === 'global' ? { scope: 'global', prompts } : { cwd, prompts })
    );
    if (exit._tag === 'Failure') {
      console.error(`Failed to save ${scope} prompts:`, exit.cause);
      return;
    }
    if (exit.value?.prompts) setLocal(exit.value.prompts);
  }, [cwd]);

  const handleSelect = useCallback((prompt: string) => {
    onClose();
    onSelect(prompt);
  }, [onClose, onSelect]);

  return (
    <div
      className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-1.5rem)] bg-popover border border-border rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto"
    >
      <PromptSection
        label={t('chat.globalPrompts')}
        prompts={globalPrompts}
        isAdding={addingSection === 'global'}
        onStartAdd={() => setAddingSection('global')}
        onCancelAdd={() => setAddingSection(null)}
        onAdd={(prompt) => {
          savePrompts('global', [...globalPrompts, prompt]);
          setAddingSection(null);
        }}
        onUpdate={(i, prompt) => savePrompts('global', globalPrompts.map((p, j) => (j === i ? prompt : p)))}
        onDelete={(i) => savePrompts('global', globalPrompts.filter((_, j) => j !== i))}
        onReorder={(prompts) => savePrompts('global', prompts)}
        onSelect={handleSelect}
      />
      {cwd && (
        <>
          <div className="border-t border-border" />
          <PromptSection
            label={t('chat.projectPrompts')}
            prompts={projectPrompts}
            isAdding={addingSection === 'project'}
            onStartAdd={() => setAddingSection('project')}
            onCancelAdd={() => setAddingSection(null)}
            onAdd={(prompt) => {
              savePrompts('project', [...projectPrompts, prompt]);
              setAddingSection(null);
            }}
            onUpdate={(i, prompt) => savePrompts('project', projectPrompts.map((p, j) => (j === i ? prompt : p)))}
            onDelete={(i) => savePrompts('project', projectPrompts.filter((_, j) => j !== i))}
            onReorder={(prompts) => savePrompts('project', prompts)}
            onSelect={handleSelect}
          />
        </>
      )}
    </div>
  );
}
