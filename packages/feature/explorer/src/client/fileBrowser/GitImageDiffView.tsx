'use client';

import { ImageDiffView } from './ImageDiffView';

/**
 * Image counterpart to DiffView for *git revisions*.
 *
 * The status pane (`StatusDiffPane`) previews an image with
 * `<FileImagePreview/>`, which can only address the working tree — fine there,
 * since the working tree IS the "after" side of an uncommitted change. History
 * surfaces (commit detail, branch compare) need the blob as it was at a
 * revision, so each side loads from `/api/git/blob?rev=…`.
 *
 * Rendering lives in `<ImageDiffView/>`; this component only resolves the two
 * URLs. Sides render only when the server said the blob exists at that
 * revision (`oldRev` / `newRev` non-null).
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

export function GitImageDiffView({ cwd, filePath, oldRev, newRev }: GitImageDiffViewProps) {
  return (
    <ImageDiffView
      filePath={filePath}
      oldSrc={oldRev ? blobUrl(cwd, oldRev, filePath) : null}
      newSrc={newRev ? blobUrl(cwd, newRev, filePath) : null}
    />
  );
}
