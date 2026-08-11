'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, toast } from '@cockpit/shared-ui';
import { ExternalLink, BookmarkPlus, SquareTerminal } from 'lucide-react';
import { toExternalBrowserAppUrl, toLocalAppUrl } from '@cockpit/shared-utils';
import { HtmlPreview } from '../HtmlPreview';
import { useAddHtmlApp } from './useAddHtmlApp';
import { HtmlAppSource } from './HtmlAppSource';

/**
 * Full-screen HTML preview modal. Mirrors MdPreviewModal's chrome; only the
 * rendered content differs. Shared across hosts (chat tool cards, the "view all
 * file changes" diff viewer, git-status / history change panes) so every entry
 * point renders the same preview / source / copy-path / add-app / open-in-console
 * affordances.
 *
 * SECURITY: opening this modal is an explicit user gesture, so the preview is
 * trusted (bash SDK enabled) — see the security note in HtmlPreview.
 */
export function HtmlPreviewModal({ filePath, content, cwd, onClose, onContentSearch }: {
  filePath: string; content: string; cwd?: string;
  onClose: () => void;
  onContentSearch?: (query: string) => void;
}) {
  const { t } = useTranslation();
  const addHtmlApp = useAddHtmlApp();
  // Preview (rendered iframe) vs. Source (read-only highlighted file). Default preview.
  const [mode, setMode] = useState<'preview' | 'source'>('preview');
  return (
    <Portal>
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-0 md:p-4" onClick={onClose}>
      <div className="bg-card shadow-xl w-full h-full rounded-none md:max-w-[90%] md:h-[90vh] md:rounded-lg flex flex-col relative overflow-hidden" onClick={e => e.stopPropagation()}>
        <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border flex-shrink-0">
          {/* Full absolute path. `direction: rtl` keeps the tail (file name)
              visible when the path is too long — the leading LRM mark pins
              the LTR text run so path segments don't reorder. Hover shows
              the full path; click copies it. */}
          <span
            className="text-sm text-muted-foreground truncate min-w-0 flex-1 cursor-pointer hover:text-foreground transition-colors"
            style={{ direction: 'rtl', textAlign: 'left' }}
            data-tooltip={filePath}
            onClick={() => {
              navigator.clipboard.writeText(filePath);
              toast(t('common.copiedPath'));
            }}
          >
            {'‎'}{filePath}
          </span>
          {/* Preview / source toggle — mirrors Explorer's single-button pattern
              (previewing → "Exit preview"; source → "Preview"). Default preview. */}
          <button
            onClick={() => setMode(m => (m === 'preview' ? 'source' : 'preview'))}
            className={`px-1.5 py-0.5 text-xs rounded transition-colors flex-shrink-0 ${
              mode === 'preview' ? 'bg-brand text-white' : 'text-muted-foreground hover:bg-accent'
            }`}
          >
            {mode === 'preview' ? t('fileBrowser.exitPreview') : t('common.preview')}
          </button>
          {/* Add this HTML to the global HTML-apps registry (html.json). filePath
              is absolute here (from the tool call). Stays open so the user can
              keep viewing; a toast confirms added / already-added. */}
          <button
            onClick={() => addHtmlApp(filePath)}
            title={t('htmlApps.addTooltip')}
            className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors flex-shrink-0"
          >
            <BookmarkPlus className="w-4 h-4" />
          </button>
          {/* Open this same HTML in a Console browser bubble (panel 3). A window
              CustomEvent lets ConsoleView create the bubble + TabManager swipe to
              console without threading a prop chain through the panels. Closing
              the modal is required: it's a fixed z-50 overlay that would otherwise
              cover the console we just switched to. */}
          <button
            onClick={() => {
              window.dispatchEvent(new CustomEvent('console-open-browser', { detail: { url: filePath } }));
              onClose();
            }}
            title={t('common.openInConsole')}
            className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors flex-shrink-0"
          >
            <SquareTerminal className="w-4 h-4" />
          </button>
          <button
            onClick={() => {
              const appUrl = toLocalAppUrl(filePath, cwd);
              window.open(toExternalBrowserAppUrl(appUrl, window.location.origin), '_blank');
            }}
            title={t('browser.openInNewWindow')}
            className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors flex-shrink-0"
          >
            <ExternalLink className="w-4 h-4" />
          </button>
          <button onClick={onClose} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors flex-shrink-0">✕</button>
        </div>
        <div className="flex-1 overflow-hidden">
          {mode === 'preview' ? (
            <HtmlPreview
              content={content}
              filePath={filePath}
              cwd={cwd}
              // Search jumps to the explorer panel — close the modal so the
              // results aren't hidden underneath it.
              onContentSearch={onContentSearch ? (query) => { onContentSearch(query); onClose(); } : undefined}
            />
          ) : (
            // Source view: entry file + its sibling deps (sidebar); text via
            // CodeViewer, images previewed. Raw files (pre-injection).
            <HtmlAppSource entryPath={filePath} entryContent={content} cwd={cwd} />
          )}
        </div>
      </div>
    </div>
    </Portal>
  );
}

export default HtmlPreviewModal;
