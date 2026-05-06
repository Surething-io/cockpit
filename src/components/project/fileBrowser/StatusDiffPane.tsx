'use client';

/**
 * StatusDiffPane — the right-hand pane of the FileBrowserModal's
 * "Status" tab.
 *
 * Renders the diff for the currently-selected changed file, with two
 * presentation modes (file-level line diff via DiffView, or chip-level
 * BlockDiffViewer) toggled locally. Pulled out of FileBrowserModal so:
 *
 *   1. `diffViewerMode` state is encapsulated next to the JSX that
 *      reads it — neighbouring tabs in the modal don't need to know
 *      it exists.
 *   2. FileBrowserModal sheds ~250 lines of nested JSX, making its
 *      remaining responsibilities (tree / search / recent / history
 *      tabs) easier to read.
 *
 * What stays in the parent:
 *
 *   - `jsonPreview` modal state — referenced from the history tab too
 *     (compare-mode JSON preview opens via the same setter), so it
 *     can't move down here without introducing prop-drill back up.
 *   - The Markdown preview modal toggle (`showStatusDiffPreview`) is
 *     owned by `useGitStatus`; we just forward through.
 *
 * Latent bug NOT fixed here: the JSON modal renders inside this
 * pane's subtree, which is gated on `activeTab === 'status'`. Setting
 * `jsonPreview` from the history tab won't show a modal until the
 * user switches tabs. Preserved as-is to keep this refactor a pure
 * structural move; fixing it requires lifting the modal to the
 * top-level FileBrowserModal layout, which is a separate concern.
 */

import { useState, type RefObject } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@/components/shared/Toast';

import { DiffView } from '@/components/project/DiffView';
import { InteractiveMarkdownPreview } from '@/components/project/InteractiveMarkdownPreview';
import { isMarkdownFile, formatAsHumanReadable } from '@/components/project/toolCallUtils';
import { type useJsonSearch, JsonSearchBar } from '@/hooks/useJsonSearch';

import { BlockDiffViewer } from './BlockDiffViewer';
import { FileImagePreview } from './FileImagePreview';
import { isImageFile } from './utils';
import type { GitFileStatus } from './types';

export interface StatusSelectedFile {
  file: GitFileStatus;
  type: 'staged' | 'unstaged';
}

export interface StatusDiffPayload {
  filePath: string;
  oldContent: string;
  newContent: string;
  isNew: boolean;
  isDeleted: boolean;
}

interface StatusDiffPaneProps {
  cwd: string;
  /** The status-tab's currently-selected file. Caller renders the
   *  pane only when this is non-null AND `diff` is non-null, so this
   *  type doesn't need to express the empty case. */
  selected: StatusSelectedFile;
  /** Loaded diff content for `selected`. */
  diff: StatusDiffPayload;

  /** Markdown-preview modal toggle, owned by `useGitStatus` upstream. */
  showMarkdownPreview: boolean;
  setShowMarkdownPreview: (v: boolean) => void;

  /** Overlays passed down to BlockDiffViewer for chip-diff cross-file
   *  navigation (pin-jump status badge, "did this neighbour change too"
   *  accent). */
  changedFiles: ReadonlySet<string>;
  fileGitStatusMap: ReadonlyMap<string, 'staged' | 'unstaged'>;

  /** "Send the selected text to project-wide content search" — wired
   *  by parent to switch to the search tab and execute the query. */
  onContentSearch: (query: string) => void;
  /** "Reveal this file in the directory tree" — wired by parent. */
  locateInTree: (path: string) => void;

  /** JSON readable-preview modal state. Lifted to the parent so the
   *  history tab can also write into it; we just consume here. The
   *  JSON modal's RENDERING currently lives inside this component
   *  (see file header for the latent-bug note). */
  jsonPreview: { content: string; filePath: string } | null;
  setJsonPreview: (v: { content: string; filePath: string } | null) => void;
  jsonPreviewSearch: ReturnType<typeof useJsonSearch>;
  jsonPreviewPreRef: RefObject<HTMLPreElement | null>;
}

export function StatusDiffPane({
  cwd,
  selected,
  diff,
  showMarkdownPreview,
  setShowMarkdownPreview,
  changedFiles,
  fileGitStatusMap,
  onContentSearch,
  locateInTree,
  jsonPreview,
  setJsonPreview,
  jsonPreviewSearch,
  jsonPreviewPreRef,
}: StatusDiffPaneProps) {
  const { t } = useTranslation();
  /** 2-way toggle:
   *  - 'file': line-by-line DiffView (default)
   *  - 'map':  BlockDiffViewer = Code Map view filtered to changed
   *            functions, with caller/callee context, amber accents
   *            on neighbours that also changed, and per-line green
   *            tint on added/modified lines.
   *
   *  Same vocabulary as the directory tree's "Code Map / 代码地图"
   *  toggle and the editor's `editorMode: 'code' | 'map'`. The git
   *  diff version just filters/decorates the same component with the
   *  diff projection. (The component itself is still called
   *  `BlockDiffViewer` because internally a Code Map is composed of
   *  per-function "blocks" / chips — the Block* names describe that
   *  primitive, not the user-facing feature.) */
  const [diffViewerMode, setDiffViewerMode] = useState<'file' | 'map'>('file');

  const filePath = selected.file.path;
  const isImage = isImageFile(filePath);
  const isBlockMode = !isImage && diffViewerMode === 'map';

  return (
    <div className="flex-1 flex flex-col overflow-hidden">
      {isBlockMode ? (
        // Code Map mode is special: the host toolbar is REMOVED and
        // BlockDiffViewer's own Header absorbs everything via render-
        // prop slots — file path, copy/locate actions, dynamic
        // git-status badge (tracks pin navigation), and the
        // file/map toggle. The merged bar is the only bar; visually
        // one row, vocabulary consistent with the directory tree's
        // Code Map view.
        <BlockDiffViewer
          cwd={cwd}
          filePath={diff.filePath}
          oldContent={diff.oldContent}
          newContent={diff.newContent}
          isNew={diff.isNew}
          isDeleted={diff.isDeleted}
          changedFiles={changedFiles}
          fileGitStatusMap={fileGitStatusMap}
          enableComments
          onContentSearch={onContentSearch}
          headerExtraLeft={({ focalFile }) => {
            if (!focalFile) return null;
            // Status reflects the CURRENT focal — pin navigation
            // moves the badge with it. Files outside the change set
            // show no badge (clean).
            const status = fileGitStatusMap.get(focalFile);
            return (
              <>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(`${cwd}/${focalFile}`);
                    toast(t('common.copiedPath'));
                  }}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                  title={t('common.copyAbsPath')}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                </button>
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    locateInTree(focalFile);
                  }}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
                  title={t('fileBrowser.locateInTree')}
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <circle cx="12" cy="12" r="10" strokeWidth={2} />
                    <circle cx="12" cy="12" r="3" strokeWidth={2} />
                    <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4M2 12h4m12 0h4" />
                  </svg>
                </button>
                {status && (
                  <span
                    className={`text-[10px] px-1.5 py-0.5 rounded flex-shrink-0 ${
                      status === 'staged'
                        ? 'bg-green-9/15 text-green-11 dark:bg-green-9/25'
                        : 'bg-amber-9/15 text-amber-11 dark:bg-amber-9/25'
                    }`}
                  >
                    {status === 'staged'
                      ? t('fileBrowser.staged')
                      : t('fileBrowser.unstaged')}
                  </span>
                )}
              </>
            );
          }}
          headerExtraRight={() => (
            <div className="flex items-center gap-0.5 rounded border border-border overflow-hidden">
              {(['file', 'map'] as const).map((mode) => (
                <button
                  key={mode}
                  onClick={(e) => {
                    e.stopPropagation();
                    setDiffViewerMode(mode);
                  }}
                  className={`px-2 py-0.5 text-[11px] transition-colors ${
                    diffViewerMode === mode
                      ? 'bg-brand text-white'
                      : 'text-muted-foreground hover:bg-accent'
                  }`}
                >
                  {t(mode === 'file' ? 'common.file' : 'common.codeMap')}
                </button>
              ))}
            </div>
          )}
        />
      ) : (
        // File mode (line-by-line DiffView) and image preview both
        // keep the original host toolbar — DiffView/FileImagePreview
        // don't have their own headers, so this is the only bar. The
        // block toggle stays here so the user can flip back to chip
        // view.
        <>
          <div className="px-4 py-2 bg-secondary border-b border-border flex items-center gap-2">
            <span className="text-xs font-mono text-muted-foreground">
              {filePath}
            </span>
            <button
              onClick={(e) => {
                e.stopPropagation();
                navigator.clipboard.writeText(`${cwd}/${filePath}`);
                toast(t('common.copiedPath'));
              }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
              title={t('common.copyAbsPath')}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
              </svg>
            </button>
            <button
              onClick={(e) => {
                e.stopPropagation();
                locateInTree(filePath);
              }}
              className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0"
              title={t('fileBrowser.locateInTree')}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <circle cx="12" cy="12" r="10" strokeWidth={2} />
                <circle cx="12" cy="12" r="3" strokeWidth={2} />
                <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4M2 12h4m12 0h4" />
              </svg>
            </button>
            <span
              className={`text-xs px-1.5 py-0.5 rounded ${
                selected.type === 'staged'
                  ? 'bg-green-9/15 text-green-11 dark:bg-green-9/25'
                  : 'bg-amber-9/15 text-amber-11 dark:bg-amber-9/25'
              }`}
            >
              {selected.type === 'staged' ? t('fileBrowser.staged') : t('fileBrowser.unstaged')}
            </span>
            <div className="flex-1" />
            {!isImage && (
              <div className="flex items-center gap-0.5 rounded border border-border overflow-hidden">
                {(['file', 'map'] as const).map((mode) => (
                  <button
                    key={mode}
                    onClick={(e) => {
                      e.stopPropagation();
                      setDiffViewerMode(mode);
                    }}
                    className={`px-2 py-0.5 text-xs transition-colors ${
                      diffViewerMode === mode
                        ? 'bg-brand text-white'
                        : 'text-muted-foreground hover:bg-accent'
                    }`}
                  >
                    {t(mode === 'file' ? 'common.file' : 'common.codeMap')}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div className="flex-1 overflow-auto">
            {isImage ? (
              <FileImagePreview
                cwd={cwd}
                path={filePath}
                className="p-4 flex items-center justify-center"
                imgClassName="max-w-full max-h-[60vh] object-contain"
                alt={filePath}
              />
            ) : (
              <DiffView
                oldContent={diff.oldContent}
                newContent={diff.newContent}
                filePath={diff.filePath}
                isNew={diff.isNew}
                isDeleted={diff.isDeleted}
                cwd={cwd}
                enableComments={true}
                onPreview={
                  !diff.isDeleted && isMarkdownFile(filePath)
                    ? () => setShowMarkdownPreview(true)
                    : !diff.isDeleted && filePath.endsWith('.json')
                      ? () => setJsonPreview({ content: diff.newContent, filePath: diff.filePath })
                      : undefined
                }
                previewLabel={filePath.endsWith('.json') ? t('common.readable') : t('common.preview')}
                onContentSearch={onContentSearch}
              />
            )}
          </div>
        </>
      )}

      {/* Git changes Markdown preview modal (supports selection
          comments + send to AI). */}
      {showMarkdownPreview && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setShowMarkdownPreview(false)}
        >
          <div
            className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-full flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <InteractiveMarkdownPreview
              content={diff.newContent}
              filePath={diff.filePath}
              cwd={cwd}
              onClose={() => setShowMarkdownPreview(false)}
            />
          </div>
        </div>
      )}

      {/* JSON readable preview modal. State is lifted to parent so the
          history tab can also trigger it; rendering lives here for
          historical reasons (see file header). */}
      {jsonPreview && (
        <div
          className="absolute inset-0 z-50 flex items-center justify-center bg-black/50"
          onClick={() => setJsonPreview(null)}
        >
          <div
            className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-[90%] flex flex-col"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-4 py-2 border-b border-border flex-shrink-0">
              <span className="text-sm text-muted-foreground font-mono truncate">
                {jsonPreview.filePath}
              </span>
              <button
                onClick={() => setJsonPreview(null)}
                className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
            <JsonSearchBar search={jsonPreviewSearch} />
            <div className="flex-1 overflow-auto px-6 py-4 bg-[#0d1117]">
              <pre
                ref={jsonPreviewPreRef}
                className="whitespace-pre-wrap break-words font-mono"
                style={{ fontSize: '0.8125rem', lineHeight: '1.5' }}
              >
                {formatAsHumanReadable(jsonPreview.content)}
              </pre>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
