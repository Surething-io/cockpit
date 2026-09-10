'use client';

import { useState, useEffect, useCallback, useRef, memo } from 'react';
import { createPortal } from 'react-dom';
import type { KeyboardEvent as ReactKeyboardEvent, DragEvent as ReactDragEvent, RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Plus, X, Pencil, Send, GripVertical, TextCursorInput,
  FolderPlus, Folder, ChevronRight, ChevronDown, Check,
} from 'lucide-react';
import { Tooltip, confirm } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  computeFlyoutPosition,
  computeDropdownPosition,
  type FlyoutPosition,
} from './instructionMenuPosition';
import {
  loadGlobalInstructionsConfig,
  loadProjectInstructionsConfig,
  saveInstructionsConfig,
  isInstructionGroup,
  type InstructionNode,
  type InstructionItem,
  type InstructionGroup,
} from './effect/agentClient';

type Scope = 'global' | 'project';

/**
 * Marks every layer this popover portals to <body>. The outside-click handler
 * measures against the trigger's wrapper, which a portaled node is NOT inside —
 * without this, clicking a submenu row or a picker option would close the whole
 * popover out from under the click. An attribute rather than a ref per layer:
 * layers mount and unmount independently, and a new one only has to opt in.
 */
const LAYER_ATTR = 'data-quick-instruction-layer';

/** True when the event landed inside any portaled layer of this popover. */
const isInsideLayer = (target: EventTarget | null): boolean =>
  target instanceof Element && target.closest(`[${LAYER_ATTR}]`) !== null;

/**
 * Optimistic-only id. The server reissues anything colliding and echoes the
 * real tree back, so this only has to be unique enough to key a row for the
 * one render between "user pressed Enter" and "POST returned".
 */
const tempId = () => Math.random().toString(36).slice(2, 10);

/**
 * Self-drawn group picker.
 *
 * NOT a native <select>: its option list is rendered by the OS, so it ignores
 * the app theme entirely (a light, system-blue menu over the dark popover) and
 * it is not bound by the panel, which the three-panel layout requires of
 * floating UI. Portaled and `fixed` for the same clipping reason as the
 * submenu — see instructionMenuPosition.ts.
 */
function GroupPicker({
  groups,
  value,
  onChange,
  onSubmit,
  onCancel,
}: {
  groups: InstructionGroup[];
  /** `null` = no group (loose at root). */
  value: string | null;
  onChange: (groupId: string | null) => void;
  /** Enter with the list already closed saves the editor, as in its input. */
  onSubmit: () => void;
  /** Escape with the list already closed cancels the whole editor. */
  onCancel: () => void;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<FlyoutPosition | null>(null);
  // Keyboard highlight is separate from `value`: arrowing through the list must
  // not commit until Enter, or a stray arrow key would silently regroup a instruction.
  const [activeIndex, setActiveIndex] = useState(0);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Index 0 is "no group", so an option's index is its group index + 1.
  const options = [null, ...groups.map((g) => g.id)];
  const label = value === null
    ? t('chat.instructionGroupNone')
    : groups.find((g) => g.id === value)?.name ?? t('chat.instructionGroupNone');

  const openList = useCallback(() => {
    const rect = triggerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPosition(computeDropdownPosition(rect, groups.length + 1, {
      width: window.innerWidth,
      height: window.innerHeight,
    }));
    setActiveIndex(Math.max(0, options.indexOf(value)));
    setOpen(true);
  }, [groups.length, options, value]);

  const closeList = useCallback(() => {
    setOpen(false);
    setPosition(null);
    triggerRef.current?.focus();
  }, []);

  const choose = useCallback((groupId: string | null) => {
    onChange(groupId);
    closeList();
  }, [onChange, closeList]);

  // Outside click. Registered only while open, so it cannot fight the popover's
  // own handler when the picker is closed.
  useEffect(() => {
    if (!open) return;
    const onMouseDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (listRef.current?.contains(target) || triggerRef.current?.contains(target)) return;
      setOpen(false);
      setPosition(null);
    };
    document.addEventListener('mousedown', onMouseDown);
    return () => document.removeEventListener('mousedown', onMouseDown);
  }, [open]);

  // The dropdown is `fixed` at coordinates captured once, so anything that moves
  // the trigger strands it — scrolling the popover list is the reachable case.
  useEffect(() => {
    if (!open) return;
    const drop = () => { setOpen(false); setPosition(null); };
    window.addEventListener('resize', drop);
    // Capture phase: the scroll happens on the popover's own scroll container
    // and scroll events do not bubble to window.
    window.addEventListener('scroll', drop, true);
    return () => {
      window.removeEventListener('resize', drop);
      window.removeEventListener('scroll', drop, true);
    };
  }, [open]);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent) => {
    if (!open) {
      if (e.key === 'ArrowDown' || e.key === ' ') {
        e.preventDefault();
        e.stopPropagation();
        openList();
      } else if (e.key === 'Enter') {
        // Enter saves, exactly as it does in the input above. Without this the
        // <button> default fires its onClick and REOPENS the list — choosing a
        // group leaves focus here, so "pick a group, press Enter to save" is
        // the ordinary path, not an edge case.
        e.preventDefault();
        e.stopPropagation();
        onSubmit();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        onCancel();
      }
      return;
    }
    // With the list open every key below belongs to the list, including
    // Escape — it closes the list only, leaving the editor alone.
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      closeList();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex((i) => Math.min(options.length - 1, i + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      e.stopPropagation();
      setActiveIndex((i) => Math.max(0, i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      e.stopPropagation();
      choose(options[activeIndex] ?? null);
    }
  }, [open, openList, closeList, choose, options, activeIndex, onSubmit, onCancel]);

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        onClick={() => (open ? closeList() : openList())}
        onKeyDown={handleKeyDown}
        className="w-full min-w-0 mt-1 px-2 py-1 flex items-center gap-1 text-xs rounded border border-input bg-background hover:bg-hover focus:outline-none focus:ring-1 focus:ring-ring transition-colors"
        title={t('chat.instructionGroupLabel')}
      >
        <Folder className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
        <span className={`flex-1 min-w-0 truncate text-left ${value === null ? 'text-muted-foreground' : ''}`}>
          {label}
        </span>
        <ChevronDown className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
      </button>

      {open && position && createPortal(
        <div
          ref={listRef}
          {...{ [LAYER_ATTR]: '' }}
          role="listbox"
          style={{
            left: position.left,
            top: position.top,
            width: position.width,
            maxHeight: position.maxHeight,
          }}
          // z-[60]: above the group submenu (z-50) it can be opened from, below
          // confirm()'s z-[200] overlay.
          className="fixed z-[60] py-1 bg-popover border border-border rounded-lg shadow-lv2 overflow-y-auto"
        >
          {options.map((groupId, i) => {
            const isSelected = groupId === value;
            return (
              <button
                key={groupId ?? '__none__'}
                type="button"
                role="option"
                aria-selected={isSelected}
                onClick={() => choose(groupId)}
                onMouseEnter={() => setActiveIndex(i)}
                className={`w-full min-w-0 px-2 py-1 flex items-center gap-1.5 text-xs text-left transition-colors ${
                  i === activeIndex ? 'bg-hover' : ''
                }`}
              >
                <Check className={`w-3 h-3 flex-shrink-0 ${isSelected ? 'text-brand' : 'opacity-0'}`} />
                <span className={`flex-1 min-w-0 truncate ${groupId === null ? 'text-muted-foreground' : ''}`}>
                  {groupId === null
                    ? t('chat.instructionGroupNone')
                    : groups.find((g) => g.id === groupId)?.name}
                </span>
              </button>
            );
          })}
        </div>,
        document.body
      )}
    </>
  );
}

/**
 * Single-line editor used for add, edit, and group rename — they differ only in
 * their initial value and whether a group picker is shown, so one component
 * keeps the Enter/Escape/IME handling in exactly one place.
 *
 * The group picker is how a instruction changes groups (there is no cross-group
 * drag): dragging into a submenu that only exists while hovered means the drop
 * target appears and disappears mid-drag, and HTML5 DnD drops `dragover` as the
 * pointer crosses into a newly mounted layer.
 */
function InstructionEditor({
  initialValue,
  placeholder,
  groupChoices,
  initialGroupId,
  onCommit,
  onCancel,
}: {
  initialValue: string;
  placeholder: string;
  /** Omit to hide the picker (adding, or renaming a group). */
  groupChoices?: InstructionGroup[];
  /** `null` = currently loose at root. */
  initialGroupId?: string | null;
  onCommit: (value: string, groupId: string | null) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initialValue);
  const [groupId, setGroupId] = useState<string | null>(initialGroupId ?? null);

  /** Shared by the input's Enter and the picker's Enter, so both save the same
   *  thing — the text AND the group, in one commit. */
  const commit = useCallback(() => {
    const trimmed = value.trim();
    if (trimmed) onCommit(trimmed, groupId);
  }, [value, groupId, onCommit]);

  const handleKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>) => {
    // isComposing guard: Enter while an IME candidate window is open commits the
    // candidate, it does not mean "save".
    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
      e.preventDefault();
      e.stopPropagation();
      commit();
    } else if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      onCancel();
    }
  }, [commit, onCancel]);

  return (
    <div className="mb-1">
      <input
        type="text"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        autoFocus
        className="w-full min-w-0 px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
      />
      {groupChoices && groupChoices.length > 0 && (
        <GroupPicker
          groups={groupChoices}
          value={groupId}
          onChange={setGroupId}
          onSubmit={commit}
          onCancel={onCancel}
        />
      )}
    </div>
  );
}

/** Shared drag affordance + hover-revealed icon buttons for one row. */
const rowClass = (isDragging: boolean, isDragOver: boolean) =>
  `flex items-center group min-w-0 rounded transition-opacity ${
    isDragging ? 'opacity-50' : ''
  } ${isDragOver ? 'border-t-2 border-brand' : ''}`;

const iconButtonClass =
  'p-1 text-muted-foreground hover:text-foreground rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0';

/** One instruction row. Used at root and inside a flyout — same markup, same handlers. */
const InstructionRow = memo(function InstructionRow({
  item,
  isDragging,
  isDragOver,
  onSelect,
  onInsert,
  onEdit,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  item: InstructionItem;
  isDragging: boolean;
  isDragOver: boolean;
  onSelect: (text: string) => void;
  onInsert: (text: string) => void;
  onEdit: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: ReactDragEvent, id: string) => void;
  onDrop: (id: string) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  return (
    // draggable sits on the row, not the grip: the grip is only an affordance,
    // and a drag started anywhere on the row still works.
    <div
      draggable
      onDragStart={() => onDragStart(item.id)}
      onDragOver={(e) => onDragOver(e, item.id)}
      onDrop={() => onDrop(item.id)}
      onDragEnd={onDragEnd}
      className={rowClass(isDragging, isDragOver)}
    >
      <GripVertical className="w-3 h-3 flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity cursor-grab" />
      {/* Tooltip wraps only this button, not the whole row. TooltipProvider
          resolves it by walking UP the parent chain, so hosting it on the row
          would make hovering the icon buttons below surface the instruction tooltip
          AND their own native `title` bubble at once. Cloned onto the button
          (no className), so `flex-1` and layout are untouched. */}
      <Tooltip content={item.text}>
        <button
          type="button"
          onClick={() => onSelect(item.text)}
          className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-hover transition-colors"
        >
          <Send className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
          <span className="truncate">{item.text}</span>
        </button>
      </Tooltip>
      {/* Icon-only: `title` stays as the sole accessible name, per the tooltip
          migration's own carve-out for unlabelled buttons. No <Tooltip> here —
          see the note on the main button above. */}
      <button
        type="button"
        onClick={() => onInsert(item.text)}
        className={iconButtonClass}
        title={t('chat.insertQuickInstruction')}
      >
        <TextCursorInput className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={() => onEdit(item.id)}
        className={iconButtonClass}
        title={t('common.edit')}
      >
        <Pencil className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(item.id)}
        className={`${iconButtonClass} hover:text-destructive`}
        title={t('common.delete')}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
});

/**
 * One group row at root level. Opening is hover-with-delay AND click: hover is
 * the intended feel, click is the only way in on a touch screen, where hover
 * does not exist at all.
 */
const GroupRow = memo(function GroupRow({
  group,
  isOpen,
  isDragging,
  isDragOver,
  isDragActive,
  onHoverOpen,
  onHoverClose,
  onToggle,
  onRename,
  onDelete,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  group: InstructionGroup;
  isOpen: boolean;
  isDragging: boolean;
  isDragOver: boolean;
  onHoverOpen: (id: string, rect: DOMRect) => void;
  onHoverClose: () => void;
  /** True while any row in this section is being dragged. */
  isDragActive: boolean;
  onToggle: (id: string, rect: DOMRect) => void;
  onRename: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: ReactDragEvent, id: string) => void;
  onDrop: (id: string) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();
  const rowRef = useRef<HTMLDivElement>(null);

  const rect = useCallback(() => rowRef.current?.getBoundingClientRect(), []);

  return (
    <div
      ref={rowRef}
      draggable
      onDragStart={() => onDragStart(group.id)}
      onDragOver={(e) => onDragOver(e, group.id)}
      onDrop={() => onDrop(group.id)}
      onDragEnd={onDragEnd}
      // Both hover handlers stand down mid-drag: dragging a row past a group
      // would otherwise pop its submenu open over the list, and dragging INSIDE
      // an open submenu fires mouseleave on the row that owns it, closing the
      // drop target out from under the pointer.
      onMouseEnter={() => { if (isDragActive) return; const r = rect(); if (r) onHoverOpen(group.id, r); }}
      onMouseLeave={() => { if (!isDragActive) onHoverClose(); }}
      className={`${rowClass(isDragging, isDragOver)} ${isOpen ? 'bg-hover' : ''}`}
    >
      <GripVertical className="w-3 h-3 flex-shrink-0 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity cursor-grab" />
      <button
        type="button"
        onClick={() => { const r = rect(); if (r) onToggle(group.id, r); }}
        className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-hover transition-colors"
        title={group.name}
      >
        <Folder className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
        {/* flex-1 min-w-0: without a shrinkable box `truncate` never engages and
            a long name pushes the count and chevron out of the row. */}
        <span className="flex-1 min-w-0 truncate">{group.name}</span>
        <span className="ml-auto flex items-center gap-1 flex-shrink-0 text-[10px] text-muted-foreground">
          {group.items.length > 0 && group.items.length}
          <ChevronRight className="w-3 h-3" />
        </span>
      </button>
      <button
        type="button"
        onClick={() => onRename(group.id)}
        className={iconButtonClass}
        title={t('common.edit')}
      >
        <Pencil className="w-3 h-3" />
      </button>
      <button
        type="button"
        onClick={() => onDelete(group.id)}
        className={`${iconButtonClass} hover:text-destructive`}
        title={t('common.delete')}
      >
        <X className="w-3 h-3" />
      </button>
    </div>
  );
});

/** Submenu listing one group's instructions. Portaled + fixed — see the geometry note. */
function GroupFlyout({
  group,
  position,
  groupChoices,
  editId,
  isAdding,
  isDragActive,
  dragId,
  dragOverId,
  onMouseEnter,
  onMouseLeave,
  onSelect,
  onInsert,
  onStartEdit,
  onCommitEdit,
  onCancelEdit,
  onDelete,
  onStartAdd,
  onCommitAdd,
  onCancelAdd,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: {
  group: InstructionGroup;
  position: FlyoutPosition;
  groupChoices: InstructionGroup[];
  editId: string | null;
  isAdding: boolean;
  dragId: string | null;
  dragOverId: string | null;
  onMouseEnter: () => void;
  onMouseLeave: () => void;
  isDragActive: boolean;
  onSelect: (text: string) => void;
  onInsert: (text: string) => void;
  onStartEdit: (id: string) => void;
  onCommitEdit: (id: string, text: string, groupId: string | null) => void;
  onCancelEdit: () => void;
  onDelete: (id: string) => void;
  onStartAdd: () => void;
  onCommitAdd: (text: string) => void;
  onCancelAdd: () => void;
  onDragStart: (id: string) => void;
  onDragOver: (e: ReactDragEvent, id: string) => void;
  onDrop: (id: string) => void;
  onDragEnd: () => void;
}) {
  const { t } = useTranslation();

  return createPortal(
    <div
      {...{ [LAYER_ATTR]: '' }}
      onMouseEnter={onMouseEnter}
      // Reordering inside the submenu drags the pointer over its own edges;
      // closing on that would cancel the drop mid-gesture.
      onMouseLeave={() => { if (!isDragActive) onMouseLeave(); }}
      style={{
        left: position.left,
        top: position.top,
        width: position.width,
        maxHeight: position.maxHeight,
      }}
      // z-50 matches the popover and stays under confirm()'s z-[200] overlay.
      className="fixed z-50 p-2 bg-popover border border-border rounded-lg shadow-lv2 overflow-y-auto"
    >
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground px-1 truncate">{group.name}</span>
        <button
          type="button"
          onClick={onStartAdd}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded flex-shrink-0"
          title={t('chat.addQuickInstruction')}
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>

      {isAdding && (
        <InstructionEditor
          initialValue=""
          placeholder={t('chat.quickInstructionPlaceholder')}
          onCommit={(text) => onCommitAdd(text)}
          onCancel={onCancelAdd}
        />
      )}

      {group.items.length === 0 && !isAdding && (
        <div className="text-xs text-muted-foreground px-1 py-1">{t('chat.noQuickInstructions')}</div>
      )}

      {group.items.map((item) =>
        editId === item.id ? (
          <InstructionEditor
            key={`edit-${item.id}`}
            initialValue={item.text}
            placeholder={t('chat.quickInstructionPlaceholder')}
            groupChoices={groupChoices}
            initialGroupId={group.id}
            onCommit={(text, groupId) => onCommitEdit(item.id, text, groupId)}
            onCancel={onCancelEdit}
          />
        ) : (
          <InstructionRow
            key={item.id}
            item={item}
            isDragging={dragId === item.id}
            isDragOver={dragOverId === item.id && dragId !== item.id}
            onSelect={onSelect}
            onInsert={onInsert}
            onEdit={onStartEdit}
            onDelete={onDelete}
            onDragStart={onDragStart}
            onDragOver={onDragOver}
            onDrop={onDrop}
            onDragEnd={onDragEnd}
          />
        )
      )}
    </div>,
    document.body
  );
}

/** Instruction list for one scope (global / project). */
function InstructionSection({
  label,
  nodes,
  scope,
  openGroupId,
  flyoutPosition,
  onOpenFlyout,
  onCloseFlyout,
  onKeepFlyout,
  onSave,
  onSelect,
  onInsert,
}: {
  label: string;
  nodes: InstructionNode[];
  scope: Scope;
  openGroupId: string | null;
  flyoutPosition: FlyoutPosition | null;
  onOpenFlyout: (scope: Scope, groupId: string, rect: DOMRect, itemCount: number, immediate: boolean) => void;
  onCloseFlyout: () => void;
  onKeepFlyout: () => void;
  onSave: (scope: Scope, nodes: InstructionNode[]) => void;
  onSelect: (text: string) => void;
  onInsert: (text: string) => void;
}) {
  const { t } = useTranslation();
  const [adding, setAdding] = useState<'instruction' | 'group' | null>(null);
  const [addingInGroup, setAddingInGroup] = useState(false);
  // Rows are addressed by id, never by index: a reorder or a regroup underneath
  // an open editor would otherwise make the pending save land on whichever row
  // now occupies that slot.
  const [editId, setEditId] = useState<string | null>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);

  const groups = nodes.filter(isInstructionGroup) as InstructionGroup[];
  const openGroup = openGroupId ? groups.find((g) => g.id === openGroupId) ?? null : null;

  // Ref indirection: `nodes` is replaced on every save, so a callback closing
  // over it churns its identity and defeats memo() on every row at once. The
  // handlers below therefore read nodesRef and keep ONE identity for the life
  // of the section (see the React performance conventions in CLAUDE.md).
  const nodesRef = useRef(nodes);
  nodesRef.current = nodes;
  const openGroupIdRef = useRef(openGroupId);
  openGroupIdRef.current = openGroupId;
  // Mirrors dragId for the same reason. The state copy still exists because the
  // rows render from it; only the callbacks read the ref.
  const dragIdRef = useRef<string | null>(null);

  // A submenu that closed or switched groups leaves its "add" editor behind,
  // pointed at a group that is no longer on screen.
  useEffect(() => { setAddingInGroup(false); }, [openGroupId]);

  const commit = useCallback((next: InstructionNode[]) => {
    setEditId(null);
    onSave(scope, next);
  }, [onSave, scope]);

  // ── Root-level mutations ────────────────────────────────────────────────
  const addInstruction = useCallback((text: string) => {
    setAdding(null);
    commit([...nodesRef.current, { id: tempId(), text }]);
  }, [commit]);

  const addGroup = useCallback((name: string) => {
    setAdding(null);
    commit([...nodesRef.current, { id: tempId(), name, items: [] }]);
  }, [commit]);

  /**
   * Edit a instruction and, in the same commit, move it to `targetGroupId`. One
   * write, so a move can never half-apply into a duplicate or a disappearance.
   */
  const saveItem = useCallback((
    itemId: string,
    text: string,
    fromGroupId: string | null,
    targetGroupId: string | null
  ) => {
    const current = nodesRef.current;
    const moved: InstructionItem = { id: itemId, text };

    // Not moving: edit in place, keeping the row's slot.
    if (fromGroupId === targetGroupId) {
      commit(current.map((n) => {
        if (isInstructionGroup(n)) {
          return n.id === targetGroupId
            ? { ...n, items: n.items.map((i) => (i.id === itemId ? moved : i)) }
            : n;
        }
        return targetGroupId === null && n.id === itemId ? moved : n;
      }));
      return;
    }

    // Moving: strip from the old home, then append to the new one. Appending
    // (not inserting) is deliberate — the row lands where the user will look
    // for it, at the end of the list it just joined.
    const stripped = fromGroupId === null
      ? current.filter((n) => isInstructionGroup(n) || n.id !== itemId)
      : current.map((n) =>
          isInstructionGroup(n) && n.id === fromGroupId
            ? { ...n, items: n.items.filter((i) => i.id !== itemId) }
            : n
        );

    commit(targetGroupId === null
      ? [...stripped, moved]
      : stripped.map((n) =>
          isInstructionGroup(n) && n.id === targetGroupId
            ? { ...n, items: [...n.items, moved] }
            : n
        ));
  }, [commit]);

  const renameGroup = useCallback((groupId: string, name: string) => {
    commit(nodesRef.current.map((n) =>
      isInstructionGroup(n) && n.id === groupId ? { ...n, name } : n
    ));
  }, [commit]);

  const deleteNode = useCallback(async (id: string) => {
    const current = nodesRef.current;
    const node = current.find((n) => n.id === id);
    // Deleting a group takes its instructions with it, and they are invisible while
    // the submenu is closed — confirm only when there is something to lose.
    if (node && isInstructionGroup(node) && node.items.length > 0) {
      const ok = await confirm(
        t('chat.deleteInstructionGroupConfirm', { name: node.name, count: node.items.length }),
        { danger: true, confirmText: t('common.delete') }
      );
      if (!ok) return;
      onCloseFlyout();
    }
    setEditId(null);
    // Re-read: the confirm above is awaited, so another save may have landed.
    commit(nodesRef.current.filter((n) => n.id !== id));
  }, [commit, t, onCloseFlyout]);

  // ── Mutations inside the open group ─────────────────────────────────────
  /** Map over the currently open group, leaving every other node untouched. */
  const patchOpenGroup = useCallback((fn: (g: InstructionGroup) => InstructionGroup) => {
    const groupId = openGroupIdRef.current;
    if (!groupId) return;
    commit(nodesRef.current.map((n) => (isInstructionGroup(n) && n.id === groupId ? fn(n) : n)));
  }, [commit]);

  const addItemToOpenGroup = useCallback((text: string) => {
    setAddingInGroup(false);
    patchOpenGroup((g) => ({ ...g, items: [...g.items, { id: tempId(), text }] }));
  }, [patchOpenGroup]);

  const deleteItemInOpenGroup = useCallback((itemId: string) => {
    setEditId(null);
    patchOpenGroup((g) => ({ ...g, items: g.items.filter((i) => i.id !== itemId) }));
  }, [patchOpenGroup]);

  const commitEditInOpenGroup = useCallback((itemId: string, text: string, groupId: string | null) => {
    saveItem(itemId, text, openGroupIdRef.current, groupId);
  }, [saveItem]);

  // ── Drag & drop: same level only ────────────────────────────────────────
  // Cross-group moves go through the editor's group picker instead — see the
  // note on InstructionEditor.
  const setDrag = useCallback((id: string | null) => {
    dragIdRef.current = id;
    setDragId(id);
  }, []);

  const clearDrag = useCallback(() => {
    setDrag(null);
    setDragOverId(null);
  }, [setDrag]);

  const handleRootDragStart = useCallback((id: string) => {
    setDrag(id);
    // An open submenu floats over the list: it is a drop target the user cannot
    // use, and it hides the rows being dragged past underneath it.
    onCloseFlyout();
  }, [setDrag, onCloseFlyout]);

  const handleDragOver = useCallback((e: ReactDragEvent, id: string) => {
    e.preventDefault();
    setDragOverId(id);
  }, []);

  /** Reorder one list, addressed by id — never by index, which shifts under an
   *  open editor and makes the pending save land on the wrong row. */
  const reorder = <T extends { id: string }>(list: T[], from: string, to: string): T[] => {
    const fromIndex = list.findIndex((n) => n.id === from);
    const toIndex = list.findIndex((n) => n.id === to);
    if (fromIndex < 0 || toIndex < 0) return list;
    const next = [...list];
    const [moved] = next.splice(fromIndex, 1);
    next.splice(toIndex, 0, moved);
    return next;
  };

  const handleRootDrop = useCallback((id: string) => {
    const from = dragIdRef.current;
    clearDrag();
    if (!from || from === id) return;
    commit(reorder(nodesRef.current, from, id));
  }, [commit, clearDrag]);

  const handleGroupDrop = useCallback((id: string) => {
    const from = dragIdRef.current;
    clearDrag();
    if (!from || from === id) return;
    patchOpenGroup((g) => ({ ...g, items: reorder(g.items, from, id) }));
  }, [patchOpenGroup, clearDrag]);

  // ── Flyout wiring ───────────────────────────────────────────────────────
  const groupItemCount = (groupId: string): number => {
    const g = nodesRef.current.find((n) => isInstructionGroup(n) && n.id === groupId);
    return g && isInstructionGroup(g) ? g.items.length : 0;
  };

  const handleHoverOpen = useCallback((groupId: string, rect: DOMRect) => {
    onOpenFlyout(scope, groupId, rect, groupItemCount(groupId), false);
  }, [onOpenFlyout, scope]);

  const handleToggle = useCallback((groupId: string, rect: DOMRect) => {
    if (openGroupIdRef.current === groupId) { onCloseFlyout(); return; }
    onOpenFlyout(scope, groupId, rect, groupItemCount(groupId), true);
  }, [onOpenFlyout, onCloseFlyout, scope]);

  return (
    <div className="p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground px-1">{label}</span>
        <div className="flex items-center gap-0.5">
          <button
            type="button"
            onClick={() => { setEditId(null); setAdding('group'); }}
            className="p-0.5 text-muted-foreground hover:text-foreground rounded"
            title={t('chat.addInstructionGroup')}
          >
            <FolderPlus className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => { setEditId(null); setAdding('instruction'); }}
            className="p-0.5 text-muted-foreground hover:text-foreground rounded"
            title={t('chat.addQuickInstruction')}
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
      </div>

      {adding === 'instruction' && (
        <InstructionEditor
          initialValue=""
          placeholder={t('chat.quickInstructionPlaceholder')}
          onCommit={(text) => addInstruction(text)}
          onCancel={() => setAdding(null)}
        />
      )}
      {adding === 'group' && (
        <InstructionEditor
          initialValue=""
          placeholder={t('chat.instructionGroupNamePlaceholder')}
          onCommit={(name) => addGroup(name)}
          onCancel={() => setAdding(null)}
        />
      )}

      {nodes.length === 0 && !adding && (
        <div className="text-xs text-muted-foreground px-1 py-1">{t('chat.noQuickInstructions')}</div>
      )}

      {nodes.map((node) => {
        if (editId === node.id) {
          return isInstructionGroup(node) ? (
            <InstructionEditor
              key={`edit-${node.id}`}
              initialValue={node.name}
              placeholder={t('chat.instructionGroupNamePlaceholder')}
              onCommit={(name) => renameGroup(node.id, name)}
              onCancel={() => setEditId(null)}
            />
          ) : (
            <InstructionEditor
              key={`edit-${node.id}`}
              initialValue={node.text}
              placeholder={t('chat.quickInstructionPlaceholder')}
              groupChoices={groups}
              initialGroupId={null}
              onCommit={(text, groupId) => saveItem(node.id, text, null, groupId)}
              onCancel={() => setEditId(null)}
            />
          );
        }
        return isInstructionGroup(node) ? (
          <GroupRow
            key={node.id}
            group={node}
            isOpen={openGroupId === node.id}
            isDragging={dragId === node.id}
            isDragOver={dragOverId === node.id && dragId !== node.id}
            isDragActive={dragId !== null}
            onHoverOpen={handleHoverOpen}
            onHoverClose={onCloseFlyout}
            onToggle={handleToggle}
            onRename={setEditId}
            onDelete={deleteNode}
            onDragStart={handleRootDragStart}
            onDragOver={handleDragOver}
            onDrop={handleRootDrop}
            onDragEnd={clearDrag}
          />
        ) : (
          <InstructionRow
            key={node.id}
            item={node}
            isDragging={dragId === node.id}
            isDragOver={dragOverId === node.id && dragId !== node.id}
            onSelect={onSelect}
            onInsert={onInsert}
            onEdit={setEditId}
            onDelete={deleteNode}
            onDragStart={handleRootDragStart}
            onDragOver={handleDragOver}
            onDrop={handleRootDrop}
            onDragEnd={clearDrag}
          />
        );
      })}

      {openGroup && flyoutPosition && (
        <GroupFlyout
          group={openGroup}
          position={flyoutPosition}
          groupChoices={groups}
          editId={editId}
          isAdding={addingInGroup}
          isDragActive={dragId !== null}
          dragId={dragId}
          dragOverId={dragOverId}
          onMouseEnter={onKeepFlyout}
          onMouseLeave={onCloseFlyout}
          onSelect={onSelect}
          onInsert={onInsert}
          onStartEdit={setEditId}
          onCommitEdit={commitEditInOpenGroup}
          onCancelEdit={() => setEditId(null)}
          onDelete={deleteItemInOpenGroup}
          onStartAdd={() => { setEditId(null); setAddingInGroup(true); }}
          onCommitAdd={addItemToOpenGroup}
          onCancelAdd={() => setAddingInGroup(false)}
          onDragStart={setDrag}
          onDragOver={handleDragOver}
          onDrop={handleGroupDrop}
          onDragEnd={clearDrag}
        />
      )}
    </div>
  );
}

interface QuickInstructionsPopoverProps {
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
  /** Fires with the instruction text; the caller sends it. */
  onSelect: (instruction: string) => void;
  /**
   * Fires with the instruction text; the caller writes it into the input box WITHOUT
   * sending. Separate from onSelect because the two differ in more than a flag:
   * insert stays available while a stream is in flight (it issues no request),
   * and it must not clobber whatever the user has half-typed.
   */
  onInsert: (instruction: string) => void;
}

/** Hover-in grace: long enough that sliding across the list does not flash a
 *  submenu per group, short enough to feel like a menu and not a tooltip. */
const HOVER_OPEN_DELAY = 150;
/** Hover-out grace: covers the diagonal from the group row to the submenu. */
const HOVER_CLOSE_DELAY = 300;

export function QuickInstructionsPopover({ cwd, anchorRef, onClose, onSelect, onInsert }: QuickInstructionsPopoverProps) {
  const { t } = useTranslation();
  const [globalNodes, setGlobalNodes] = useState<InstructionNode[]>([]);
  const [projectNodes, setProjectNodes] = useState<InstructionNode[]>([]);
  const [flyout, setFlyout] = useState<{ scope: Scope; groupId: string; position: FlyoutPosition } | null>(null);

  const openTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearTimers = useCallback(() => {
    if (openTimer.current) { clearTimeout(openTimer.current); openTimer.current = null; }
    if (closeTimer.current) { clearTimeout(closeTimer.current); closeTimer.current = null; }
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Mounted only while open (parent renders conditionally), so this is the
  // open-time load.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [globalExit, projectExit] = await Promise.all([
        BrowserRuntime.runPromiseExit(loadGlobalInstructionsConfig()),
        cwd ? BrowserRuntime.runPromiseExit(loadProjectInstructionsConfig(cwd)) : null,
      ]);
      if (cancelled) return;
      if (globalExit._tag === 'Success') setGlobalNodes(globalExit.value.instructions ?? []);
      else console.error('Failed to load global instructions:', globalExit.cause);
      if (projectExit && projectExit._tag === 'Success') setProjectNodes(projectExit.value.instructions ?? []);
      else if (projectExit) console.error('Failed to load project instructions:', projectExit.cause);
    })();
    return () => { cancelled = true; };
  }, [cwd]);

  // Close on outside click. Every floating layer (submenu, group picker) is
  // portaled to <body> and so is NOT a descendant of anchorRef — without the
  // layer test, clicking a submenu row or a picker option would close the
  // popover out from under the click.
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (isInsideLayer(e.target)) return;
      const root = anchorRef.current;
      if (root && !root.contains(e.target as Node)) onClose();
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [anchorRef, onClose]);

  // The flyout is `fixed` at coordinates captured from one getBoundingClientRect,
  // so anything that moves its row silently strands it. Scrolling the popover is
  // the reachable case (the list is `overflow-y-auto`); resize covers the rest.
  useEffect(() => {
    if (!flyout) return;
    const drop = () => { clearTimers(); setFlyout(null); };
    window.addEventListener('resize', drop);
    // Capture phase: the scroll happens on the popover's own scroll container,
    // and scroll events do not bubble to window.
    window.addEventListener('scroll', drop, true);
    return () => {
      window.removeEventListener('resize', drop);
      window.removeEventListener('scroll', drop, true);
    };
  }, [flyout, clearTimers]);

  const openFlyout = useCallback((
    scope: Scope,
    groupId: string,
    rect: DOMRect,
    itemCount: number,
    immediate: boolean
  ) => {
    clearTimers();
    const apply = () => setFlyout({
      scope,
      groupId,
      position: computeFlyoutPosition(rect, itemCount, {
        width: window.innerWidth,
        height: window.innerHeight,
      }),
    });
    if (immediate) apply();
    else openTimer.current = setTimeout(apply, HOVER_OPEN_DELAY);
  }, [clearTimers]);

  const closeFlyout = useCallback(() => {
    clearTimers();
    closeTimer.current = setTimeout(() => setFlyout(null), HOVER_CLOSE_DELAY);
  }, [clearTimers]);

  /** Pointer made it into the submenu — cancel the pending close. */
  const keepFlyout = useCallback(() => clearTimers(), [clearTimers]);

  // Optimistic update, then RECONCILE with what the server actually persisted:
  // POST normalizes (trims, drops empties, collapses duplicates per scope,
  // reissues ids), so keeping the optimistic tree would leave the popover
  // disagreeing with disk — and the next edit would write the stale tree
  // straight back. It is also the only place a newly added row's real id exists.
  const saveInstructions = useCallback(async (scope: Scope, nodes: InstructionNode[]) => {
    const setLocal = scope === 'global' ? setGlobalNodes : setProjectNodes;
    setLocal(nodes);
    const exit = await BrowserRuntime.runPromiseExit(
      saveInstructionsConfig(scope === 'global' ? { scope: 'global', instructions: nodes } : { cwd, instructions: nodes })
    );
    if (exit._tag === 'Failure') {
      console.error(`Failed to save ${scope} instructions:`, exit.cause);
      return;
    }
    if (exit.value?.instructions) setLocal(exit.value.instructions);
  }, [cwd]);

  const handleSelect = useCallback((instruction: string) => {
    onClose();
    onSelect(instruction);
  }, [onClose, onSelect]);

  // Close first, same as handleSelect: the popover sits directly over the input
  // box, so leaving it open would hide the text that was just inserted.
  const handleInsert = useCallback((instruction: string) => {
    onClose();
    onInsert(instruction);
  }, [onClose, onInsert]);

  return (
    <div className="absolute bottom-full left-0 mb-2 w-80 max-w-[calc(100vw-1.5rem)] bg-popover border border-border rounded-lg shadow-lv2 z-50 max-h-[70vh] overflow-y-auto">
      <InstructionSection
        label={t('chat.globalInstructions')}
        nodes={globalNodes}
        scope="global"
        openGroupId={flyout?.scope === 'global' ? flyout.groupId : null}
        flyoutPosition={flyout?.scope === 'global' ? flyout.position : null}
        onOpenFlyout={openFlyout}
        onCloseFlyout={closeFlyout}
        onKeepFlyout={keepFlyout}
        onSave={saveInstructions}
        onSelect={handleSelect}
        onInsert={handleInsert}
      />
      {cwd && (
        <>
          <div className="border-t border-border" />
          <InstructionSection
            label={t('chat.projectInstructions')}
            nodes={projectNodes}
            scope="project"
            openGroupId={flyout?.scope === 'project' ? flyout.groupId : null}
            flyoutPosition={flyout?.scope === 'project' ? flyout.position : null}
            onOpenFlyout={openFlyout}
            onCloseFlyout={closeFlyout}
            onKeepFlyout={keepFlyout}
            onSave={saveInstructions}
            onSelect={handleSelect}
            onInsert={handleInsert}
          />
        </>
      )}
    </div>
  );
}
