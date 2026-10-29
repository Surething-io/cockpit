'use client';

import { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import i18n from '@cockpit/shared-i18n';
import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Placeholder from '@tiptap/extension-placeholder';
import { Table } from '@tiptap/extension-table';
import { TableRow } from '@tiptap/extension-table-row';
import { TableCell } from '@tiptap/extension-table-cell';
import { TableHeader } from '@tiptap/extension-table-header';
import { TaskList } from '@tiptap/extension-task-list';
import { TaskItemTriState } from './taskItemTriState';
import Link from '@tiptap/extension-link';
import { Markdown } from 'tiptap-markdown';
import { Slice, type Node as PMNode } from '@tiptap/pm/model';
import { CollapsibleHeading } from './CollapsibleHeading';
import { NoteOrgKeymap } from './noteOrgKeymap';
import { getMarkdown } from '@cockpit/feature-agent';
import { SlashCommandMenu } from '@cockpit/feature-agent';
import { NoteToolbar } from './NoteToolbar';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { Effect } from 'effect';
import { toast, MODAL_SHELL_CLASS, ProjectNumberChip } from '@cockpit/shared-ui';
import { Globe } from 'lucide-react';
import { loadNote, loadNoteList, saveNote as saveNoteEff, type NoteListEntry } from './effect/workspaceClient';
import { normalizeNoteMarkdown } from './noteMarkdown';
import { MarkdownTaskListFix } from './markdownTaskListFix';
import { DropShellCleanup } from './dropShellCleanup';

// ============================================
// NoteModal main component
// ============================================

interface NoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  /** Note to open on: a project path, or null for the global note. */
  projectCwd?: string | null;
  /** Active project — always listed, even with an empty note, so it can be started. */
  currentCwd?: string;
  /** Sidebar project order — numbers each row's chip like the project list. */
  projectOrder: readonly string[];
}

const projectNameOf = (cwd: string) => cwd.split('/').filter(Boolean).pop() || cwd;

/** "3 minutes ago" — same buckets as the session boards. */
function formatRelative(t: (key: string, opts?: Record<string, unknown>) => string, ms: number): string {
  const minutes = Math.floor((Date.now() - ms) / 60000);
  if (minutes < 1) return t('common.justNow');
  if (minutes < 60) return t('common.minutesAgo', { count: minutes });
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return t('common.hoursAgo', { count: hours });
  return t('common.daysAgo', { count: Math.floor(hours / 24) });
}

/** Rows keyed by cwd; the global note has no cwd. */
const keyOf = (cwd: string | null) => cwd ?? '';

/**
 * NoteModal — the notes board: every note on the left (the global note first,
 * then project notes, most recently edited first), the selected note open for
 * editing on the right. Opened from the sidebar "Notes" row (lands on the
 * global note) and from a project row's note icon (lands on that project).
 *
 * The left column lists only notes with content, plus the active project and
 * the note the board was opened on even when empty — otherwise every project
 * ever opened would show up, most of them blank.
 *
 * One tiptap instance serves every note. Switching flushes the pending
 * debounced save of the note being left FIRST (its own path and conflict
 * baseline), then loads the next. A save that resolves after the switch must
 * not touch the editor or the baseline of the note now open — `activeKeyRef`
 * is what tells them apart.
 */
export function NoteModal({ isOpen, onClose, projectCwd, currentCwd, projectOrder }: NoteModalProps) {
  const { t } = useTranslation();
  // Which note the editor is bound to (null = global). Set on open.
  const [activeCwd, setActiveCwd] = useState<string | null>(projectCwd ?? null);
  const activeKeyRef = useRef(keyOf(projectCwd ?? null));
  const activeCwdRef = useRef<string | null>(projectCwd ?? null);
  const [notes, setNotes] = useState<NoteListEntry[]>([]);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const hasUnsavedChanges = useRef(false);
  // mtime of the note as we last loaded/saved it — the optimistic-concurrency
  // token sent with every save so the server can detect an out-of-band edit.
  const baseMtimeRef = useRef<number | undefined>(undefined);

  // Slash command state
  const [slashMenu, setSlashMenu] = useState<{ query: string; position: { top: number; left: number } } | null>(null);
  const slashStartPos = useRef<number | null>(null);

  const refreshList = useCallback(() => {
    BrowserRuntime.runPromiseExit(loadNoteList()).then((exit) => {
      if (exit._tag === 'Success') setNotes(exit.value);
    });
  }, []);

  // Save note. `cwd` is explicit (not the active note): a flush on switch saves
  // the note being LEFT, and must still land there after the switch.
  const saveNote = useCallback(async (cwd: string | null, content: string) => {
    // Strip empty-checkbox round-trip artifacts before persisting, so junk
    // "[ ]" / "\[ \]" lines can never accumulate in the file. See noteMarkdown.ts.
    const normalized = normalizeNoteMarkdown(content);
    setIsSaving(true);
    // Read synchronously, before any await: the baseline of THIS note.
    const baseMtime = baseMtimeRef.current;
    const exit = await BrowserRuntime.runPromiseExit(
      saveNoteEff(cwd, normalized, baseMtime).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => console.error('Failed to save note:', err))
        )
      )
    );
    // Still the open note? If the user switched away meanwhile, the editor and
    // the baseline now belong to another note — leave both alone.
    const stillActive = activeKeyRef.current === keyOf(cwd);
    if (exit._tag === 'Success') {
      const result = exit.value;
      if (result.conflict && !stillActive) {
        toast(t('editor.conflictReloaded'), 'info');
      } else if (result.conflict) {
        // The note changed on disk since we loaded it (another tab / external
        // editor). Discard this ~5s batch of unsaved local edits and reload
        // the latest, rather than silently clobbering the other writer.
        // emitUpdate:false so the reload itself never schedules a fresh save.
        editorRef.current?.commands.setContent(result.content, { emitUpdate: false });
        baseMtimeRef.current = result.mtime;
        hasUnsavedChanges.current = false;
        toast(t('editor.conflictReloaded'), 'info');
      } else if (stillActive) {
        baseMtimeRef.current = result.mtime;
        hasUnsavedChanges.current = false;
      }
      // Row time / first line — and an empty note that just got content.
      refreshList();
    }
    setIsSaving(false);
  }, [t, refreshList]);

  // Debounced save with 5-second delay
  const debouncedSave = useCallback((content: string) => {
    hasUnsavedChanges.current = true;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    const cwd = activeCwdRef.current;
    saveTimerRef.current = setTimeout(() => {
      saveNote(cwd, content);
    }, 5000);
  }, [saveNote]);

  // Tiptap editor
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        // Heading is provided by CollapsibleHeading below (adds fold support).
        heading: false,
        // Link ships inside StarterKit since v3, but we register our own configured
        // copy below (autolink, target=_blank, .tiptap-link). Registering both makes
        // tiptap warn about the duplicate name and keep only one of them.
        link: false,
      }),
      CollapsibleHeading.configure({
        levels: [1, 2, 3],
      }),
      NoteOrgKeymap,
      Placeholder.configure({
        placeholder: () => i18n.t('editor.placeholder'),
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
      TaskItemTriState.configure({ nested: true }),
      // Split markdown-it's merged plain-bullet + task-list <ul> before it
      // reaches the schema, so no phantom empty checkbox is generated on load.
      MarkdownTaskListFix,
      // Remove the empty item shell a text-selection drag-move leaves behind
      // at the source (todo & plain list items). See dropShellCleanup.ts.
      DropShellCleanup,
      Markdown.configure({
        html: true,
        // Keep ProseMirror's native copy: write both text/html (rich text,
        // preserves table/todo structure) and text/plain (the visible
        // selection text). transformCopiedText would override the plain-text
        // serializer with lossy Markdown that no longer matches the selection.
        transformCopiedText: false,
        transformPastedText: true,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-editor focus:outline-none min-h-[60vh] px-6 py-4',
      },
      // ProseMirror's default text/plain serializer joins blocks with '\n\n',
      // so copying to a plain-text target gains a blank line between blocks and
      // a trailing newline. Use a single '\n' between blocks and strip trailing
      // newlines so the pasted text matches the selected line count.
      clipboardTextSerializer: slice =>
        slice.content
          .textBetween(0, slice.content.size, '\n')
          .replace(/\n+$/, ''),
      // Trim empty leading/trailing textblocks from the copied slice before it
      // is serialized. A selection that reaches past the end of a line pulls in
      // a trailing empty paragraph, which rich-text targets (e.g. macOS Notes)
      // render as an extra blank line. Runs before both the HTML and plain-text
      // serializers, so both branches benefit. Internal blank lines are kept.
      transformCopied: slice => {
        const isEmptyBlock = (node: PMNode | null) =>
          !!node && node.isTextblock && node.content.size === 0;
        let content = slice.content;
        let { openStart, openEnd } = slice;
        while (content.childCount > 1 && isEmptyBlock(content.lastChild)) {
          content = content.cut(0, content.size - content.lastChild!.nodeSize);
          openEnd = 0;
        }
        while (content.childCount > 1 && isEmptyBlock(content.firstChild)) {
          content = content.cut(content.firstChild!.nodeSize);
          openStart = 0;
        }
        return new Slice(content, openStart, openEnd);
      },
      handleClick: (view, pos, event) => {
        // Cmd/Ctrl + click to open link
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
        // Backspace in empty code block exits the code block
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
        // Trigger slash command on / input
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

      // Update slash command query
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

  // Store editor ref for use inside handleKeyDown closure
  const editorRef = useRef<typeof editor>(null);
  useEffect(() => {
    // editorRef is captured by the handleKeyDown closure passed to
    // useEditor(...) above; the editor instance doesn't exist yet at that
    // point, so back-filling the ref here is the standard tiptap pattern.
    // eslint-disable-next-line react-hooks/immutability
    editorRef.current = editor;
  }, [editor]);

  // Opening the board: land on the requested note and fetch the list.
  useEffect(() => {
    if (!isOpen) return;
    const cwd = projectCwd ?? null;
    activeCwdRef.current = cwd;
    activeKeyRef.current = keyOf(cwd);
    setActiveCwd(cwd);
    setSearchKeyword('');
    refreshList();
  }, [isOpen, projectCwd, refreshList]);

  // Load the active note into the editor.
  useEffect(() => {
    if (!isOpen || !editor) return;

    setIsLoading(true);
    setSlashMenu(null);
    slashStartPos.current = null;
    let cancelled = false;
    BrowserRuntime.runPromiseExit(loadNote(activeCwd)).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success') {
        // emitUpdate:false so merely opening the note never fires onUpdate /
        // schedules a save (which would otherwise persist a re-serialized doc).
        editor.commands.setContent(exit.value.content || '', { emitUpdate: false });
        // Record the load-time mtime as the concurrency baseline for saves.
        baseMtimeRef.current = exit.value.mtime;
        // Belt-and-suspenders: clear any save the load might have scheduled.
        if (saveTimerRef.current) {
          clearTimeout(saveTimerRef.current);
          saveTimerRef.current = null;
        }
        hasUnsavedChanges.current = false;
      } else {
        console.error('Failed to load note:', exit.cause);
      }
      setIsLoading(false);
    });
    return () => { cancelled = true; };
  }, [isOpen, editor, activeCwd]);

  // Write the pending debounced save of the open note right now.
  const flushSave = useCallback(() => {
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
      saveTimerRef.current = null;
    }
    if (hasUnsavedChanges.current && editor) {
      saveNote(activeCwdRef.current, getMarkdown(editor));
      hasUnsavedChanges.current = false;
    }
  }, [editor, saveNote]);

  const selectNote = useCallback((cwd: string | null) => {
    if (keyOf(cwd) === activeKeyRef.current) return;
    flushSave();
    activeCwdRef.current = cwd;
    activeKeyRef.current = keyOf(cwd);
    setActiveCwd(cwd);
  }, [flushSave]);

  // Save on close
  const handleClose = useCallback(() => {
    flushSave();
    setSlashMenu(null);
    slashStartPos.current = null;
    onClose();
  }, [flushSave, onClose]);

  // Cleanup timer
  useEffect(() => {
    return () => {
      if (saveTimerRef.current) {
        clearTimeout(saveTimerRef.current);
      }
    };
  }, []);

  // ESC to close (when slash menu is open, ESC closes the menu first)
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

  // Left column: the global note always first; then the active project and the
  // note the board was opened on even when empty (so they can be started);
  // then every other note with content, most recently edited first.
  const rows = useMemo(() => {
    const byKey = new Map(notes.map((n) => [keyOf(n.cwd), n]));
    const keys = new Set<string>(['']);
    const out: { cwd: string | null; entry?: NoteListEntry }[] = [{ cwd: null, entry: byKey.get('') }];
    for (const cwd of [projectCwd ?? null, currentCwd ?? null]) {
      if (!cwd || keys.has(keyOf(cwd)) || byKey.has(keyOf(cwd))) continue;
      keys.add(keyOf(cwd));
      out.push({ cwd });
    }
    for (const entry of [...notes].sort((a, b) => b.mtime - a.mtime)) {
      if (keys.has(keyOf(entry.cwd))) continue;
      keys.add(keyOf(entry.cwd));
      out.push({ cwd: entry.cwd, entry });
    }
    return out;
  }, [notes, projectCwd, currentCwd]);

  const nameOf = useCallback(
    (cwd: string | null) => (cwd ? projectNameOf(cwd) : t('editor.globalNote')),
    [t],
  );

  const visibleRows = useMemo(() => {
    const keyword = searchKeyword.trim().toLowerCase();
    if (!keyword) return rows;
    return rows.filter(({ cwd, entry }) =>
      nameOf(cwd).toLowerCase().includes(keyword) ||
      (cwd?.toLowerCase().includes(keyword) ?? false) ||
      (entry?.searchText.includes(keyword) ?? false),
    );
  }, [rows, searchKeyword, nameOf]);

  if (!isOpen) return null;

  const activeKey = keyOf(activeCwd);

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Background overlay */}
      <div className="absolute inset-0 bg-scrim" onClick={handleClose} />

      {/* Modal */}
      <div className={MODAL_SHELL_CLASS}>
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2 min-w-0">
            <h2 className="text-sm font-medium text-foreground truncate">
              {activeCwd ? t('editor.noteTitle', { name: projectNameOf(activeCwd) }) : t('editor.globalNote')}
            </h2>
            {isSaving && (
              <span className="text-xs text-muted-foreground flex-shrink-0">{t('editor.saving')}</span>
            )}
          </div>
          <button
            onClick={handleClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        <div className="flex-1 flex min-h-0">
          {/* Left: search + notes list. Below `md` it is hidden — the editor is
              the point of this board, so it keeps the narrow screen. */}
          <div className="hidden md:flex w-[300px] min-h-0 flex-shrink-0 border-r border-border flex-col">
            <div className="p-3 flex-shrink-0 border-b border-border">
              <input
                type="text"
                placeholder={t('editor.searchNotes')}
                value={searchKeyword}
                onChange={(e) => setSearchKeyword(e.target.value)}
                className="w-full px-2 py-1 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
              />
            </div>
            <div className="flex-1 min-h-0 overflow-y-auto p-2 space-y-0.5">
              {visibleRows.map(({ cwd, entry }) => {
                const number = cwd ? projectOrder.indexOf(cwd) + 1 : 0;
                const isActive = keyOf(cwd) === activeKey;
                return (
                  <div
                    key={keyOf(cwd) || '(global)'}
                    onClick={() => selectNote(cwd)}
                    title={cwd ?? undefined}
                    className={`rounded-md px-3 py-2 cursor-pointer transition-colors ${
                      isActive ? 'bg-brand/10' : 'hover:bg-hover'
                    }`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {cwd === null ? (
                        <Globe className="w-[18px] h-[18px] p-0.5 flex-shrink-0 text-muted-foreground" />
                      ) : number > 0 ? (
                        <ProjectNumberChip number={number} isActive={cwd === currentCwd} />
                      ) : (
                        // Not open in the sidebar: keep the column aligned.
                        <span className="w-[18px] flex-shrink-0" />
                      )}
                      <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0">{nameOf(cwd)}</span>
                      {entry && entry.mtime > 0 && (
                        <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatRelative(t, entry.mtime)}</span>
                      )}
                    </div>
                    <div className="text-xs text-muted-foreground truncate mt-0.5 pl-6">
                      {entry?.firstLine || t('editor.emptyNote')}
                    </div>
                  </div>
                );
              })}
            </div>
          </div>

          {/* Right: the selected note, editable */}
          <div className="flex-1 min-w-0 flex flex-col">
            {/* Toolbar */}
            <NoteToolbar editor={editor} />

            {/* Editor area */}
            <div className="flex-1 overflow-y-auto">
              {isLoading ? (
                <div className="flex items-center justify-center py-12 text-muted-foreground">
                  <span>{t('common.loading')}</span>
                </div>
              ) : (
                <EditorContent editor={editor} />
              )}
            </div>
          </div>
        </div>
      </div>

      {/* Slash command menu */}
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
