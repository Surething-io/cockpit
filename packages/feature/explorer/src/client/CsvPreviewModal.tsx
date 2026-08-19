'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, toast } from '@cockpit/shared-ui';
import { CsvTableView } from './CsvTableView';
import { CodeViewer } from './CodeViewer';

/**
 * Full-screen CSV/TSV preview. Mirrors HtmlPreviewModal's chrome (path +
 * copy-on-click, one toggle button, close) so a spreadsheet artifact off an AI
 * reply opens the same way a `.md` or `.html` one does.
 *
 * Two views, table by default: the parsed grid, and the raw delimited source
 * through CodeViewer (line numbers + search) for when the parse is the thing
 * being checked.
 *
 * Content is a prop, not fetched here — same reason as MdPreviewModal: hosts
 * already differ in how they read the file.
 */
export function CsvPreviewModal({ filePath, content, onClose, zClassName = 'z-50' }: {
  filePath: string;
  content: string;
  onClose: () => void;
  /** Raise above z-50 when opened from inside another overlay (Portal renders to <body>). */
  zClassName?: string;
}) {
  const { t } = useTranslation();
  const [mode, setMode] = useState<'table' | 'raw'>('table');

  return (
    <Portal>
      <div
        className={`fixed inset-0 ${zClassName} flex items-center justify-center bg-scrim p-0 md:p-4`}
        onClick={onClose}
      >
        <div
          className="bg-card shadow-lv3 w-full h-full rounded-none md:max-w-[90%] md:h-[90vh] md:rounded-lg flex flex-col relative overflow-hidden"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border flex-shrink-0">
            {/* Full absolute path, tail-visible when long (see HtmlPreviewModal). Click copies. */}
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
            <div className="flex items-center gap-1 bg-accent rounded p-0.5 flex-shrink-0">
              {(['table', 'raw'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setMode(m)}
                  className={`px-2 py-0.5 text-xs rounded transition-colors ${
                    mode === m ? 'bg-card text-foreground shadow-lv1' : 'text-muted-foreground hover:text-foreground'
                  }`}
                >
                  {t(`csv.${m}`)}
                </button>
              ))}
            </div>
            <button
              onClick={onClose}
              className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors flex-shrink-0"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            {mode === 'table' ? (
              <CsvTableView content={content} filePath={filePath} className="h-full" />
            ) : (
              <CodeViewer
                content={content}
                filePath={filePath}
                showLineNumbers={true}
                showSearch={true}
                className="h-full"
              />
            )}
          </div>
        </div>
      </div>
    </Portal>
  );
}

export default CsvPreviewModal;
