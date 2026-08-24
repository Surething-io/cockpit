'use client';

import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Presentational image diff: before / after, side by side.
 *
 * Deliberately knows nothing about WHERE the bytes come from — it takes a URL
 * per side. Git history passes /api/git/blob URLs (see `GitImageDiffView`,
 * which wraps this); the chat snapshot viewer passes /api/snapshots/blob URLs
 * for the shadow repo, whose objects the git route cannot reach.
 *
 * A side may instead pass a NODE (`oldNode` / `newNode`) when it resolves its
 * own bytes and owns its own loading / missing / too-large states — that's the
 * working-tree side of the status pane, where `<FileImagePreview/>` stats the
 * file first to get an ETag. Handing a bare URL to `<img>` there would either
 * flicker (while the stat is in flight) or serve a stale cached image.
 *
 * A side renders only when it has a src or a node, so an added file shows one
 * image and a deleted file shows the version that was removed — never a
 * broken <img>.
 */
export interface ImageDiffViewProps {
  filePath: string;
  /** "before" image; null when the file was added. */
  oldSrc?: string | null;
  /** "after" image; null when the file was deleted. */
  newSrc?: string | null;
  /** Self-resolving "before" side; takes precedence over `oldSrc`. */
  oldNode?: ReactNode;
  /** Self-resolving "after" side; takes precedence over `newSrc`. */
  newNode?: ReactNode;
}

function ImageSide({
  label,
  labelClassName,
  src,
  node,
  alt,
}: {
  label: string;
  labelClassName: string;
  src?: string | null;
  node?: ReactNode;
  alt: string;
}) {
  const { t } = useTranslation();
  const [failed, setFailed] = useState(false);

  return (
    <div className="flex-1 min-w-0 flex flex-col items-center gap-2">
      <div className={`text-xs font-medium ${labelClassName}`}>{label}</div>
      <div className="w-full flex-1 flex items-center justify-center rounded border border-border bg-secondary p-3 min-h-[8rem]">
        {node ??
          (failed ? (
            <span className="text-xs text-muted-foreground">{t('diffViewer.imageLoadFailed')}</span>
          ) : (
            <img
              src={src!}
              alt={alt}
              onError={() => setFailed(true)}
              className="max-w-full max-h-[60vh] object-contain"
            />
          ))}
      </div>
    </div>
  );
}

export function ImageDiffView({
  filePath,
  oldSrc,
  newSrc,
  oldNode,
  newNode,
}: ImageDiffViewProps) {
  const { t } = useTranslation();
  const hasOld = !!oldNode || !!oldSrc;
  const hasNew = !!newNode || !!newSrc;

  return (
    <div className="h-full overflow-auto p-4">
      <div className="text-xs font-mono text-muted-foreground mb-3 truncate">{filePath}</div>
      {!hasOld && !hasNew ? (
        <div className="text-sm text-muted-foreground">{t('diffViewer.imageUnavailable')}</div>
      ) : (
        <div className="flex flex-wrap items-stretch gap-4">
          {hasOld && (
            <ImageSide
              label={hasNew ? t('diffViewer.imageBefore') : t('diffViewer.imageDeleted')}
              labelClassName="text-red-11"
              src={oldSrc}
              node={oldNode}
              alt={`${filePath} (before)`}
            />
          )}
          {hasNew && (
            <ImageSide
              label={hasOld ? t('diffViewer.imageAfter') : t('diffViewer.imageAdded')}
              labelClassName="text-green-11"
              src={newSrc}
              node={newNode}
              alt={`${filePath} (after)`}
            />
          )}
        </div>
      )}
    </div>
  );
}
