'use client';

/**
 * GraphBuildProgress — the Code Map's loading state.
 *
 * Replaces a bare "Loading…" for what is often a multi-second and
 * occasionally multi-TEN-second wait (measured on a production server, with
 * no dev-mode compilation in the way: 2.0s @ 255 files, 8.0s @ 4.5k files,
 * 17.9s @ 7.7k files — and `MAX_FILES` is now 15000, so the ceiling is
 * higher still).
 *
 * Where the data comes from: `buildCodeIndex` emits progress frames, which
 * `src/lib/effect/fileWatchHandler.ts` forwards over `/ws/watch?cwd=`.
 * `useWebSocket` de-dupes connections BY URL, so subscribing here reuses the
 * very socket FileBrowserModal already holds — no second connection, and no
 * prop-drilling of a 10 fps value through the modal (which would re-render
 * every sibling panel; see the React performance conventions in CLAUDE.md).
 *
 * Degrades to a plain spinner-ish message when no frame has arrived. That's
 * the normal case for a WARM index (the request resolves in single-digit ms,
 * far too fast for a frame) and also covers a build that started before this
 * component mounted but is past its phase transition — the server replays its
 * last frame on subscribe, so that gap is at most one throttle window.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWebSocket } from '@cockpit/shared-ui';

/** Mirrors `BuildProgressEvent` in
 *  `server/codeMap/projectGraph/buildProgress.ts`. Duplicated rather than
 *  imported because that module pulls in `node:fs` transitively — importing
 *  the type alone would still drag the server file into the browser bundle
 *  under `isolatedModules`. */
interface GraphProgress {
  cwd: string;
  phase: 'listing' | 'contexts' | 'parsing' | 'resolving' | 'edges' | 'done';
  filesDone: number;
  filesTotal: number;
  currentFile?: string;
  percent: number;
}

interface GraphBuildProgressProps {
  cwd: string;
}

export function GraphBuildProgress({ cwd }: GraphBuildProgressProps) {
  const { t } = useTranslation();
  const [progress, setProgress] = useState<GraphProgress | null>(null);

  // Reset when the project changes — a stale bar from the previous cwd would
  // read as "this project is 70% built".
  useEffect(() => {
    setProgress(null);
  }, [cwd]);

  const onMessage = useCallback(
    (msg: unknown) => {
      const m = msg as { type?: string; data?: GraphProgress };
      if (m?.type !== 'graphProgress' || !m.data) return;
      // The socket is per-cwd already, but the shared-connection cache is
      // keyed by URL string — guard anyway so an encoding mismatch can't
      // cross-wire two projects.
      if (m.data.cwd !== cwd) return;
      // Do NOT clear on `done`. The server is finished, but this component
      // stays mounted until `useFileFunctions` flips to `ready` and BlockViewer
      // swaps in the map — and that tail is not free: the response lands ~10ms
      // after `done`, then the browser has to render the whole map (blocks,
      // highlighting, pin chips), which can take seconds on a big file.
      // Clearing to null here dropped the user back to a bare "Loading…" for
      // that entire window, which reads as "it finished, then got stuck again".
      // Holding the completed bar keeps the last painted frame honest.
      //
      // Store the frame verbatim — the server already sends percent=100 for
      // `done` (PHASE_RANGE.done). Overriding percent here would pin the bar
      // at 100% for EVERY frame, which is exactly the bug this line replaced:
      // the label counted 4502/7661 while the bar sat full.
      setProgress(m.data);
    },
    [cwd],
  );

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage,
  });

  // Hold the last non-empty path so the line doesn't flicker to blank on the
  // phase frames (which carry no file).
  const lastFileRef = useRef<string>('');
  if (progress?.currentFile) lastFileRef.current = progress.currentFile;

  if (!progress) {
    return (
      <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
        {t('blockViewer.fileMode.loading', 'Loading…')}
      </div>
    );
  }

  const phaseLabel = t(
    `blockViewer.buildProgress.${progress.phase}`,
    PHASE_FALLBACK[progress.phase],
  );
  const pct = Math.max(0, Math.min(100, Math.round(progress.percent)));

  return (
    <div className="flex-1 flex flex-col items-center justify-center gap-3 px-8">
      <div className="w-full max-w-md flex flex-col gap-2">
        <div className="flex items-baseline justify-between text-xs text-muted-foreground">
          <span>{phaseLabel}</span>
          <span className="tabular-nums">
            {progress.phase === 'parsing' && progress.filesTotal > 0
              ? `${progress.filesDone} / ${progress.filesTotal}`
              : `${pct}%`}
          </span>
        </div>

        <div className="h-1 w-full overflow-hidden rounded-full bg-muted">
          <div
            className="h-full rounded-full bg-primary transition-[width] duration-150 ease-linear"
            style={{ width: `${pct}%` }}
          />
        </div>

        {/* Fixed height + truncate: the path changes ~10x/second, so letting
            it wrap or collapse would make the whole block jitter. Blanked once
            the build is done — a frozen path under a finished bar looks stuck. */}
        <div
          className="h-4 truncate text-left font-mono text-[11px] leading-4 text-muted-foreground/70"
          dir="rtl"
          title={progress.phase === 'done' ? '' : lastFileRef.current}
        >
          {progress.phase === 'done' ? '' : lastFileRef.current}
        </div>
      </div>
    </div>
  );
}

const PHASE_FALLBACK: Record<GraphProgress['phase'], string> = {
  listing: 'Listing files…',
  contexts: 'Reading project config…',
  parsing: 'Parsing files',
  resolving: 'Resolving imports…',
  edges: 'Building call graph…',
  // `done` is only ever shown during the tail between the server finishing and
  // the map painting — "Done" would be misleading while the user still waits.
  done: 'Finishing up…',
};
