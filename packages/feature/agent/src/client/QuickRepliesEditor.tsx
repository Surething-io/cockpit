'use client';

import { useCallback, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal, useEscToClose } from '@cockpit/shared-ui';
import {
  formatQuickReplies,
  parseQuickReplies,
  type QuickReplyLang,
} from './quickReplies';

/**
 * Dialog for editing the selection toolbar's quick-reply phrases.
 *
 * Deliberately rendered by MessageList, NOT inside FloatingToolbar: the host
 * drops the toolbar on any mousedown outside `.floating-toolbar`
 * (MessageList.handleSelectionMouseDown), so a dialog mounted under the panel
 * would unmount itself the moment the user clicked into its own textarea.
 * Living out here means the text selection is gone by the time the dialog is
 * up — which is fine, because nothing in here acts on the selection.
 *
 * One textarea rather than per-phrase rows: the panel's structure IS the line
 * breaks, so a row-based editor would need its own "new row" / "move to row"
 * affordances to express what a newline already says.
 */
export function QuickRepliesEditor({
  initialRows,
  lang,
  isCustomized,
  onSave,
  onRestoreDefault,
  onClose,
}: {
  /** What the panel currently shows — custom phrases, or the defaults when
   *  nothing is customized yet, so the user edits from a filled buffer. */
  initialRows: readonly (readonly string[])[];
  lang: QuickReplyLang;
  /** Drives whether "restore defaults" is offered — restoring an already
   *  default panel is a no-op button that only invites a confused click. */
  isCustomized: boolean;
  onSave: (rows: string[][]) => void;
  onRestoreDefault: () => void;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [text, setText] = useState(() => formatQuickReplies(initialRows, lang));

  useEscToClose(onClose);

  const handleSave = useCallback(() => {
    onSave(parseQuickReplies(text));
    onClose();
  }, [text, onSave, onClose]);

  const handleRestore = useCallback(() => {
    onRestoreDefault();
    onClose();
  }, [onRestoreDefault, onClose]);

  return (
    <Portal>
      <div
        className="fixed inset-0 z-[300] flex items-center justify-center bg-black/50 p-4"
        onClick={onClose}
      >
        <div
          className="bg-card border border-border rounded-lg shadow-xl w-full max-w-md flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between px-4 py-3 border-b border-border">
            <h2 className="text-sm font-medium text-foreground">{t('quickReply.editTitle')}</h2>
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              aria-label={t('quickReply.cancel')}
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          <div className="px-4 py-3 flex flex-col gap-2">
            <p className="text-xs text-muted-foreground">{t('quickReply.editHint')}</p>
            <textarea
              autoFocus
              value={text}
              onChange={(e) => setText(e.target.value)}
              placeholder={t('quickReply.editPlaceholder')}
              rows={6}
              spellCheck={false}
              className="w-full px-2 py-1.5 text-xs font-mono bg-background border border-border rounded text-foreground focus:outline-none focus:border-brand resize-y"
            />
            <p className="text-xs text-muted-foreground">
              {t('quickReply.customizedFor', {
                lang: t(lang === 'zh' ? 'quickReply.langZh' : 'quickReply.langEn'),
              })}
            </p>
          </div>

          <div className="flex items-center justify-between px-4 py-3 border-t border-border">
            <button
              onClick={handleRestore}
              disabled={!isCustomized}
              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            >
              {t('quickReply.restoreDefault')}
            </button>
            <div className="flex items-center gap-2">
              <button
                onClick={onClose}
                className="px-3 py-1.5 text-xs border border-border text-foreground rounded-md hover:bg-accent transition-colors"
              >
                {t('quickReply.cancel')}
              </button>
              <button
                onClick={handleSave}
                className="px-3 py-1.5 text-xs font-medium border border-brand text-brand rounded-md hover:bg-brand/10 transition-colors"
              >
                {t('quickReply.save')}
              </button>
            </div>
          </div>
        </div>
      </div>
    </Portal>
  );
}
