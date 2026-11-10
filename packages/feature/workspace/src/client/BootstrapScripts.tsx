'use client';

import { useRef } from 'react';
import { useServerInsertedHTML } from 'next/navigation';

interface BootstrapScriptsProps {
  bootScript: string;
  buildId: string | null;
  forceUpdate: boolean;
}

/** Emit parser-executed scripts once per document, outside the hydrated tree. */
export function BootstrapScripts({ bootScript, buildId, forceUpdate }: BootstrapScriptsProps) {
  const inserted = useRef(false);
  useServerInsertedHTML(() => {
    if (inserted.current) return null;
    inserted.current = true;
    return <>
      <script id="cockpit-boot" dangerouslySetInnerHTML={{ __html: bootScript }} />
      <script id="cockpit-build" dangerouslySetInnerHTML={{ __html:
        `window.__COCKPIT_BUILD_ID__=${JSON.stringify(buildId).replace(/</g, '\\u003c')};` +
        `window.__COCKPIT_FORCE_UPDATE__=${JSON.stringify(forceUpdate)};`,
      }} />
    </>;
  });
  return null;
}
