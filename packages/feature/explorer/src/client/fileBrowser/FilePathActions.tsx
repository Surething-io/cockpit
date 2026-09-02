'use client';

import { memo } from 'react';
import { useTranslation } from 'react-i18next';
import { toast, Tooltip } from '@cockpit/shared-ui';

interface FilePathActionsProps {
  cwd: string;
  filePath: string;
  onLocateInTree?: (filePath: string) => void;
}

/** File path plus the two standard Explorer path actions. */
export const FilePathActions = memo(function FilePathActions({
  cwd,
  filePath,
  onLocateInTree,
}: FilePathActionsProps) {
  const { t } = useTranslation();

  return (
    <div className="flex items-center gap-1 min-w-0">
      <span className="text-sm text-muted-foreground truncate" title={filePath}>
        {filePath}
      </span>
      <Tooltip content={t('common.copyAbsPath')}>
        <button
          onClick={(event) => {
            event.stopPropagation();
            navigator.clipboard.writeText(`${cwd}/${filePath}`);
            toast(t('common.copiedPath'));
          }}
          className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0"
        >
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
          </svg>
        </button>
      </Tooltip>
      {onLocateInTree && (
        <Tooltip content={t('fileBrowser.locateInTree')}>
          <button
            onClick={(event) => {
              event.stopPropagation();
              onLocateInTree(filePath);
            }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <circle cx="12" cy="12" r="10" strokeWidth={2} />
              <circle cx="12" cy="12" r="3" strokeWidth={2} />
              <path strokeLinecap="round" strokeWidth={2} d="M12 2v4m0 12v4M2 12h4m12 0h4" />
            </svg>
          </button>
        </Tooltip>
      )}
    </div>
  );
});
