'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
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
import { CollapsibleHeading } from './CollapsibleHeading';
import { getMarkdown } from '@cockpit/feature-agent';
import { SlashCommandMenu } from '@cockpit/feature-agent';
import { NoteToolbar } from './NoteToolbar';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { Effect } from 'effect';
import { toast } from '@cockpit/shared-ui';
import { loadNote, saveNote as saveNoteEff } from './effect/workspaceClient';
import { normalizeNoteMarkdown } from './noteMarkdown';
import { MarkdownTaskListFix } from './markdownTaskListFix';
import { DropShellCleanup } from './dropShellCleanup';

// ============================================
// NoteModal main component
// ============================================

interface NoteModalProps {
  isOpen: boolean;
  onClose: () => void;
  projectCwd?: string | null;
  projectName?: string | null;
}

export function NoteModal({ isOpen, onClose, projectCwd, projectName }: NoteModalProps) {
  const { t } = useTranslation();
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

  // Save note
  const saveNote = useCallback(async (content: string) => {
    // Strip empty-checkbox round-trip artifacts before persisting, so junk
    // "[ ]" / "\[ \]" lines can never accumulate in the file. See noteMarkdown.ts.
    const normalized = normalizeNoteMarkdown(content);
    setIsSaving(true);
    const exit = await BrowserRuntime.runPromiseExit(
      saveNoteEff(projectCwd, normalized, baseMtimeRef.current).pipe(
        Effect.tapError((err) =>
          Effect.sync(() => console.error('Failed to save note:', err))
        )
      )
    );
    if (exit._tag === 'Success') {
      const result = exit.value;
      if (result.conflict) {
        // The note changed on disk since we loaded it (another tab / external
        // editor). Discard this ~5s batch of unsaved local edits and reload
        // the latest, rather than silently clobbering the other writer.
        // emitUpdate:false so the reload itself never schedules a fresh save.
        editorRef.current?.commands.setContent(result.content, { emitUpdate: false });
        baseMtimeRef.current = result.mtime;
        hasUnsavedChanges.current = false;
        toast(t('editor.conflictReloaded'), 'info');
      } else {
        baseMtimeRef.current = result.mtime;
        hasUnsavedChanges.current = false;
      }
    }
    setIsSaving(false);
  }, [projectCwd, t]);

  // Debounced save with 5-second delay
  const debouncedSave = useCallback((content: string) => {
    hasUnsavedChanges.current = true;
    if (saveTimerRef.current) {
      clearTimeout(saveTimerRef.current);
    }
    saveTimerRef.current = setTimeout(() => {
      saveNote(content);
    }, 5000);
  }, [saveNote]);

  // Tiptap editor
  const editor = useEditor({
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        // Heading is provided by CollapsibleHeading below (adds fold support).
        heading: false,
      }),
      CollapsibleHeading.configure({
        levels: [1, 2, 3],
      }),
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
        transformCopiedText: true,
        transformPastedText: true,
      }),
    ],
    editorProps: {
      attributes: {
        class: 'tiptap-editor focus:outline-none min-h-[60vh] px-6 py-4',
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

  // Load content when opened
  useEffect(() => {
    if (!isOpen || !editor) return;

    setIsLoading(true);
    setSlashMenu(null);
    slashStartPos.current = null;
    BrowserRuntime.runPromiseExit(loadNote(projectCwd)).then((exit) => {
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
  }, [isOpen, editor, projectCwd]);

  // Save on close
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

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Background overlay */}
      <div className="absolute inset-0 bg-black/50" onClick={handleClose} />

      {/* Modal */}
      <div className="relative bg-card rounded-lg shadow-xl w-full max-w-6xl h-[90vh] mx-4 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-foreground">{projectName ? t('editor.noteTitle', { name: projectName }) : t('editor.noteUntitled')}</h2>
            {isSaving && (
              <span className="text-xs text-muted-foreground">{t('editor.saving')}</span>
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
