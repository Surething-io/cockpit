'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Presentational image diff: two `<img>` sides, before / after.
 *
 * Deliberately knows nothing about WHERE the bytes come from — it takes a URL
 * per side. Git history passes /api/git/blob URLs (see `GitImageDiffView`,
 * which wraps this); the chat snapshot viewer passes /api/snapshots/blob URLs
 * for the shadow repo, whose objects the git route cannot reach.
 *
 * A side renders only when its src is non-null, so an added file shows one
 * image and a deleted file shows the version that was removed — never a
 * broken <img>.
 */
export interface ImageDiffViewProps {
  filePath: string;
  /** "before" image; null when the file was added. */
  oldSrc?: string | null;
  /** "after" image; null when the file was deleted. */
  newSrc?: string | null;
}

function ImageSide({
  label,
  labelClassName,
  src,
  alt,
}: {
  label: string;
  labelClassName: string;
  src: string;
  alt: string;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex-1 min-w-0 flex flex-col items-center gap-2">
      <div className={`text-xs font-medium ${labelClassName}`}>{label}</div>
      <div className="w-full flex-1 flex items-center justify-center rounded border border-border bg-secondary p-3 min-h-[8rem]">
        {failed ? (
          <span className="text-xs text-muted-foreground">{t('diffViewer.imageLoadFailed')}</span>
        ) : (
          <img
            src={src}
            alt={alt}
            onError={() => setFailed(true)}
            className="max-w-full max-h-[60vh] object-contain"
          />
        )}
      </div>
    </div>
  );
}

export function ImageDiffView({ filePath, oldSrc, newSrc }: ImageDiffViewProps) {
  const { t } = useTranslation();

  return (
    <div className="h-full overflow-auto p-4">
      <div className="text-xs font-mono text-muted-foreground mb-3 truncate">{filePath}</div>
      {!oldSrc && !newSrc ? (
        <div className="text-sm text-muted-foreground">{t('diffViewer.imageUnavailable')}</div>
      ) : (
        <div className="flex flex-wrap items-stretch gap-4">
          {oldSrc && (
            <ImageSide
              label={newSrc ? t('diffViewer.imageBefore') : t('diffViewer.imageDeleted')}
              labelClassName="text-red-11"
              src={oldSrc}
              alt={`${filePath} (before)`}
            />
          )}
          {newSrc && (
            <ImageSide
              label={oldSrc ? t('diffViewer.imageAfter') : t('diffViewer.imageAdded')}
              labelClassName="text-green-11"
              src={newSrc}
              alt={`${filePath} (after)`}
            />
          )}
        </div>
      )}
    </div>
  );
}
