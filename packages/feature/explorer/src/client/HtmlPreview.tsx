'use client';

import React from 'react';

interface HtmlPreviewProps {
  /** Raw HTML source */
  content: string;
  /** File path — used as a React key so the iframe reloads on file switch */
  filePath: string;
}

/**
 * In-place HTML preview: renders a single, self-contained .html/.htm file in a
 * sandboxed iframe via `srcDoc`. Mirrors the markdown in-place preview UX (the
 * host toolbar owns the Preview toggle); only the rendered content differs.
 *
 * Single-file self-contained by design — relative resources (sibling css/js/img)
 * are NOT resolved. The `sandbox` allows scripts and same-origin so inline JS and
 * forms work, while keeping the page isolated from the app.
 */
export function HtmlPreview({ content, filePath }: HtmlPreviewProps) {
  return (
    <div className="h-full w-full bg-white">
      <iframe
        key={filePath}
        srcDoc={content}
        title={filePath}
        sandbox="allow-scripts allow-same-origin"
        className="h-full w-full border-0"
      />
    </div>
  );
}

export default HtmlPreview;
