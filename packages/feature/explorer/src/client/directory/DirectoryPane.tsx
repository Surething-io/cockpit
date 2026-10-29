'use client';

import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { InteractiveMarkdownPreview } from '../InteractiveMarkdownPreview';
import { SimpleCodeBlock } from '../CodeViewer';
import { toast } from '@cockpit/shared-ui';
import {
  loadDirFiles,
  loadDirFile,
  type DirFilesEndpoint,
  type DirFileLite,
  type DirFileContent,
} from '@cockpit/shared-api';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { DirectoryFileTree } from './DirectoryFileTree';

interface DirectoryPaneProps {
  /** Which board's directory route serves this item. */
  endpoint: DirFilesEndpoint;
  /** Item id understood by `endpoint` (skill id, Bot id). */
  id: string;
  /** The item's own file, opened first (SKILL.md, BOT.md). */
  entryFile: string;
  /** Header title (e.g. `/name`, `@name`). */
  title: ReactNode;
  /** Extra header controls after the preview/source switch (delete, close…). */
  actions?: ReactNode;
  /** Handed to the embedded markdown preview (its own Esc / close affordance). */
  onClose?: () => void;
}

type ViewMode = 'preview' | 'source';

const noop = () => {};
/** File tree column: default width is also the minimum; drag widens it up to +50%. */
const TREE_WIDTH = 224;
const TREE_WIDTH_MIN = TREE_WIDTH;
const TREE_WIDTH_MAX = TREE_WIDTH * 1.5;
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/**
 * One directory-shaped item — a skill, a Bot, an HTML app: header (title, current file's
 * path, copy), a preview/source switch, a file tree column when the directory
 * holds more than its entry file, and the picked file's body. Markdown renders
 * (with the source switch); anything else shows as highlighted source;
 * binaries and oversized files show a note only.
 *
 * Both boards' routes answer the same shapes (shared-api `loadDirFiles` /
 * `loadDirFile`), so this component knows nothing about either registry.
 *
 * Mount with `key={id}` when the item can change, so the listing, the picked
 * file and the view mode reset with it.
 */
export function DirectoryPane({ endpoint, id, entryFile, title, actions, onClose = noop }: DirectoryPaneProps) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<ViewMode>('preview');
  // null = listing; undefined = the directory could not be read
  const [files, setFiles] = useState<DirFileLite[] | null | undefined>(null);
  const [dir, setDir] = useState('');
  const [selected, setSelected] = useState(entryFile);
  // The picked file; null while loading.
  const [file, setFile] = useState<DirFileContent | null>(null);

  // File tree width, dragged on the divider to its right. Not persisted — a
  // transient "widen it to read a long name" tweak, same policy as the explorer
  // file browser's tree divider (FileBrowserModal), whose handling this mirrors.
  const [treeWidth, setTreeWidth] = useState(TREE_WIDTH);
  const treeResizeRef = useRef<{ startX: number; startWidth: number } | null>(null);
  // Mouse only: on touch, a horizontal drag belongs to the three-panel swipe.
  const onResizeStart = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.pointerType !== 'mouse' || e.button !== 0) return;
    e.preventDefault(); // no text selection while dragging
    treeResizeRef.current = { startX: e.clientX, startWidth: treeWidth };
    e.currentTarget.setPointerCapture(e.pointerId);
  }, [treeWidth]);
  const onResizeMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    const drag = treeResizeRef.current;
    if (!drag) return;
    const next = drag.startWidth + (e.clientX - drag.startX);
    setTreeWidth(Math.min(TREE_WIDTH_MAX, Math.max(TREE_WIDTH_MIN, next)));
  }, []);
  const onResizeEnd = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!treeResizeRef.current) return;
    treeResizeRef.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
  }, []);

  useEffect(() => {
    let cancelled = false;
    BrowserRuntime.runPromiseExit(loadDirFiles(endpoint, id)).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success') {
        setFiles(exit.value.files);
        setDir(exit.value.dir);
      } else {
        setFiles(undefined);
      }
    });
    return () => { cancelled = true; };
  }, [endpoint, id]);

  useEffect(() => {
    let cancelled = false;
    setFile(null);
    BrowserRuntime.runPromiseExit(loadDirFile(endpoint, id, selected)).then((exit) => {
      if (cancelled) return;
      setFile(exit._tag === 'Success' ? exit.value : { path: selected, kind: 'binary', size: 0 });
    });
    return () => { cancelled = true; };
  }, [endpoint, id, selected]);

  // Absolute path of the file on screen.
  const shownPath = dir ? `${dir}/${selected}` : '';
  const shownIsMarkdown = isMarkdown(selected);
  const showTree = !!files && files.length > 1;

  const handleCopyPath = useCallback(async () => {
    if (!shownPath) return;
    try {
      await navigator.clipboard.writeText(shownPath);
      toast(t('common.copiedPath'), 'success');
    } catch {
      toast(t('common.copyFailed'), 'error');
    }
  }, [shownPath, t]);

  const centered = (text: string) => (
    <div className="flex-1 flex items-center justify-center text-muted-foreground text-sm">{text}</div>
  );

  const renderSource = (content: string, path: string) => (
    <div className="flex-1 overflow-auto">
      <SimpleCodeBlock content={content} filePath={path} className="min-h-full" />
    </div>
  );

  const renderBody = () => {
    if (files === undefined) return centered(t('skills.cannotRead'));
    if (!file) return centered(t('common.loading'));
    if (file.kind !== 'text') {
      return centered(file.kind === 'tooLarge' ? t('skills.fileTooLarge') : t('skills.fileNotPreviewable'));
    }
    const content = file.content ?? '';
    if (!shownIsMarkdown || mode === 'source') return renderSource(content, shownPath || selected);
    return (
      // Embedded markdown preview with TOC sidebar — same component as the chat
      // message stream. TOC starts collapsed: the boards already spend two
      // columns (item list, file tree) to its left.
      <InteractiveMarkdownPreview
        content={content}
        filePath={shownPath || selected}
        cwd={dir}
        embedded
        onClose={onClose}
        tocDefaultCollapsed
      />
    );
  };

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      {/* Header */}
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-medium text-foreground truncate">{title}</h2>
            <button
              onClick={handleCopyPath}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors"
              title={t('skills.copyPath')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
              </svg>
            </button>
          </div>
          {shownPath && (
            <div className="text-xs text-muted-foreground font-mono truncate mt-0.5" data-tooltip={shownPath}>
              {shownPath}
            </div>
          )}
        </div>

        {/* Mode switcher — markdown only; other files are always source. */}
        <div className={`flex items-center rounded-md border border-border overflow-hidden text-xs flex-shrink-0 ${shownIsMarkdown ? '' : 'invisible'}`}>
          <button
            onClick={() => setMode('preview')}
            className={`px-3 py-1 transition-colors ${
              mode === 'preview'
                ? 'bg-brand text-white'
                : 'text-muted-foreground hover:text-foreground hover:bg-hover'
            }`}
          >
            {t('common.preview')}
          </button>
          <button
            onClick={() => setMode('source')}
            className={`px-3 py-1 transition-colors ${
              mode === 'source'
                ? 'bg-brand text-white'
                : 'text-muted-foreground hover:text-foreground hover:bg-hover'
            }`}
          >
            {t('skills.source')}
          </button>
        </div>

        {actions}
      </div>

      <div className="flex-1 flex min-h-0">
        {showTree && (
          <>
            <div className="flex-shrink-0 overflow-y-auto" style={{ width: treeWidth }}>
              <DirectoryFileTree files={files} selected={selected} onSelect={setSelected} />
            </div>
            {/* Divider — 5px hit area around a 1px line, drag to resize the tree */}
            <div
              onPointerDown={onResizeStart}
              onPointerMove={onResizeMove}
              onPointerUp={onResizeEnd}
              onPointerCancel={onResizeEnd}
              className="w-[5px] flex-shrink-0 relative cursor-col-resize group"
            >
              <div className="absolute inset-y-0 left-1/2 -translate-x-1/2 w-px bg-border group-hover:bg-brand transition-colors" />
            </div>
          </>
        )}
        <div className="flex-1 flex flex-col min-w-0 min-h-0">{renderBody()}</div>
      </div>
    </div>
  );
}
