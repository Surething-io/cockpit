'use client';

import { useCallback, useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CodeViewer } from '@cockpit/feature-explorer';
import { MenuContainerProvider, Portal, toast } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { copyTextToClipboard } from './effect/clipboard';

/** Plain text stays literal, including Markdown syntax and HTML tags. */
export function TextPreviewModal({ filePath, content, onClose }: {
  filePath: string;
  content: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [container, setContainer] = useState<HTMLElement | null>(null);

  const handleCopyPath = useCallback(() => {
    BrowserRuntime.runPromiseExit(copyTextToClipboard(filePath)).then((exit) => {
      const copied = exit._tag === 'Success';
      toast(t(copied ? 'common.copiedPath' : 'common.copyFailed'), copied ? 'success' : 'error');
    });
  }, [filePath, t]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-scrim p-0 md:p-4"
        onClick={onClose}
      >
        <div
          ref={setContainer}
          className="bg-card shadow-lv3 w-full h-full rounded-none md:max-w-[90%] md:h-[90vh] md:rounded-lg flex flex-col relative overflow-hidden"
          onClick={(event) => event.stopPropagation()}
        >
          <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border flex-shrink-0">
            <button
              type="button"
              onClick={handleCopyPath}
              aria-label={t('common.copyAbsPath')}
              className="text-sm text-muted-foreground truncate min-w-0 flex-1 cursor-pointer hover:text-foreground transition-colors"
              style={{ direction: 'rtl', textAlign: 'left' }}
              title={filePath}
            >
              <bdi dir="ltr">{filePath}</bdi>
            </button>
            <button
              onClick={onClose}
              aria-label={t('common.close')}
              className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors flex-shrink-0"
            >
              ✕
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-hidden">
            <MenuContainerProvider container={container}>
              <CodeViewer content={content} filePath={filePath} className="h-full" />
            </MenuContainerProvider>
          </div>
        </div>
      </div>
    </Portal>
  );
}
