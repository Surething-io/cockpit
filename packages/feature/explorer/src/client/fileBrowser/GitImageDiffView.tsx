'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

/**
 * Image counterpart to DiffView for *git revisions*.
 *
 * The status pane (`StatusDiffPane`) previews an image with
 * `<FileImagePreview/>`, which can only address the working tree — fine there,
 * since the working tree IS the "after" side of an uncommitted change. History
 * surfaces (commit detail, branch compare) need the blob as it was at a
 * revision, so each side loads from `/api/git/blob?rev=…`.
 *
 * Sides render only when the server said the blob exists at that revision
 * (`oldRev` / `newRev` non-null), so an added file shows one image and a
 * deleted file shows the version that was removed — never a broken <img>.
 */
export interface GitImageDiffViewProps {
  cwd: string;
  filePath: string;
  /** Revision holding the "before" blob; null when the file was added. */
  oldRev?: string | null;
  /** Revision holding the "after" blob; null when the file was deleted. */
  newRev?: string | null;
}

const blobUrl = (cwd: string, rev: string, filePath: string) =>
  `/api/git/blob?cwd=${encodeURIComponent(cwd)}&rev=${encodeURIComponent(rev)}&file=${encodeURIComponent(filePath)}`;

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

export function GitImageDiffView({ cwd, filePath, oldRev, newRev }: GitImageDiffViewProps) {
  const { t } = useTranslation();

  return (
    <div className="h-full overflow-auto p-4">
      <div className="text-xs font-mono text-muted-foreground mb-3 truncate">{filePath}</div>
      {!oldRev && !newRev ? (
        <div className="text-sm text-muted-foreground">{t('diffViewer.imageUnavailable')}</div>
      ) : (
        <div className="flex flex-wrap items-stretch gap-4">
          {oldRev && (
            <ImageSide
              label={newRev ? t('diffViewer.imageBefore') : t('diffViewer.imageDeleted')}
              labelClassName="text-red-11"
              src={blobUrl(cwd, oldRev, filePath)}
              alt={`${filePath} @ ${oldRev}`}
            />
          )}
          {newRev && (
            <ImageSide
              label={oldRev ? t('diffViewer.imageAfter') : t('diffViewer.imageAdded')}
              labelClassName="text-green-11"
              src={blobUrl(cwd, newRev, filePath)}
              alt={`${filePath} @ ${newRev}`}
            />
          )}
        </div>
      )}
    </div>
  );
}
