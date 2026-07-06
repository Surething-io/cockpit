'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import type { PDFDocumentProxy } from 'pdfjs-dist';

/**
 * Themed, virtualized PDF preview.
 *
 * Replaces the browser's native <iframe> PDF viewer for two reasons the native
 * viewer couldn't satisfy:
 *   1. **Theme** — the toolbar/background are our DOM, so they follow the app's
 *      light/dark theme (the native PDFium toolbar is a fixed dark bar we can't
 *      restyle).
 *   2. **Scroll performance** — only the pages inside the virtual window are
 *      rendered to <canvas> (via @tanstack/react-virtual), so scrolling a large
 *      deck stays smooth instead of waiting on PDFium's lazy full-page raster.
 *
 * The bytes come from `/api/files/read` (streamed, Range-capable). pdf.js is
 * imported lazily inside an effect so it never evaluates during SSR, and its
 * worker is served as a static asset from `/pdfjs/pdf.worker.min.mjs`
 * (vendored by scripts/copy-pdfjs-worker.mjs).
 */

export interface FilePdfPreviewProps {
  cwd: string;
  path: string;
  /** Bump to force a reload (file-watcher integration); also busts the byte cache. */
  refreshKey?: number;
}

/** Vertical gap (px) between rendered pages. */
const PAGE_GAP = 16;
/** Horizontal padding (px, both sides) + rough scrollbar allowance. */
const H_PAD = 32;
/** Zoom bounds and step. */
const MIN_ZOOM = 0.25;
const MAX_ZOOM = 4;
const ZOOM_STEP = 1.2;

/** Thumbnail sidebar geometry. */
const THUMB_W = 100; // rendered thumbnail width (px)
const THUMB_LABEL_H = 18; // page-number label height (px)
const THUMB_GAP = 12; // vertical gap between thumbnails (px)
const SIDEBAR_W = 132; // total sidebar width (px)

type DocState =
  | { kind: 'loading' }
  | { kind: 'ready' }
  | { kind: 'error'; message: string };

export function FilePdfPreview({ cwd, path, refreshKey }: FilePdfPreviewProps) {
  const scrollRef = useRef<HTMLDivElement>(null);

  const [docState, setDocState] = useState<DocState>({ kind: 'loading' });
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  /** First page size in PDF points (scale 1); slide decks are uniform, so this drives layout. */
  const [base, setBase] = useState<{ w: number; h: number } | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  const [zoom, setZoom] = useState(1); // 1 == fit-width
  const [currentPage, setCurrentPage] = useState(1);
  const [showThumbs, setShowThumbs] = useState(true);

  // ---- Load document (lazy pdf.js import keeps it out of SSR) ----
  useEffect(() => {
    let cancelled = false;
    setDocState({ kind: 'loading' });
    setDoc(null);
    setNumPages(0);
    setBase(null);
    setCurrentPage(1);

    // The loading task owns the worker + document; destroying it tears both down.
    let loadingTask: { promise: Promise<PDFDocumentProxy>; destroy: () => Promise<void> } | null =
      null;

    (async () => {
      try {
        const pdfjs = await import('pdfjs-dist');
        pdfjs.GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.min.mjs';

        const url =
          `/api/files/read?cwd=${encodeURIComponent(cwd)}` +
          `&path=${encodeURIComponent(path)}` +
          `&v=${encodeURIComponent(String(refreshKey ?? ''))}`;

        loadingTask = pdfjs.getDocument({ url });
        const loaded = await loadingTask.promise;
        if (cancelled) return;
        const first = await loaded.getPage(1);
        const vp = first.getViewport({ scale: 1 });

        setDoc(loaded);
        setNumPages(loaded.numPages);
        setBase({ w: vp.width, h: vp.height });
        setDocState({ kind: 'ready' });
      } catch (err) {
        if (!cancelled) {
          setDocState({
            kind: 'error',
            message: err instanceof Error ? err.message : 'Failed to load PDF',
          });
        }
      }
    })();

    return () => {
      cancelled = true;
      try {
        loadingTask?.destroy();
      } catch {
        /* noop */
      }
    };
  }, [cwd, path, refreshKey]);

  // ---- Track container width (fit-to-width + resize) ----
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const update = () => setContainerWidth(Math.max(0, el.clientWidth - H_PAD));
    update();
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ---- Derived layout ----
  const fitScale = base && containerWidth > 0 ? containerWidth / base.w : 1;
  const renderScale = fitScale * zoom;
  const pageW = base ? base.w * renderScale : 0;
  const pageH = base ? base.h * renderScale : 0;
  const rowSize = pageH + PAGE_GAP;

  // ---- Virtualize pages ----
  const rowVirtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => rowSize,
    overscan: 2,
  });

  // Recompute slot heights whenever the page size (zoom / width) changes.
  useEffect(() => {
    if (rowSize > 0) rowVirtualizer.measure();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rowSize]);

  const handleScroll = useCallback(() => {
    if (rowSize <= 0) return;
    const top = scrollRef.current?.scrollTop ?? 0;
    const page = Math.min(numPages, Math.max(1, Math.floor(top / rowSize) + 1));
    setCurrentPage(page);
  }, [rowSize, numPages]);

  const zoomIn = useCallback(() => setZoom((z) => Math.min(MAX_ZOOM, z * ZOOM_STEP)), []);
  const zoomOut = useCallback(() => setZoom((z) => Math.max(MIN_ZOOM, z / ZOOM_STEP)), []);
  const zoomReset = useCallback(() => setZoom(1), []);
  const toggleThumbs = useCallback(() => setShowThumbs((v) => !v), []);

  // Jump the main view to a page (0-based index) — used by thumbnail clicks.
  const handleSelectPage = useCallback(
    (index: number) => {
      rowVirtualizer.scrollToIndex(index, { align: 'start' });
      setCurrentPage(index + 1);
    },
    [rowVirtualizer],
  );

  const virtualItems = rowVirtualizer.getVirtualItems();
  const totalSize = rowVirtualizer.getTotalSize();

  const toolbar = useMemo(
    () => (
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border bg-secondary text-muted-foreground text-xs select-none">
        <button
          onClick={toggleThumbs}
          className={`px-1.5 py-0.5 rounded hover:bg-accent transition-colors ${
            showThumbs ? 'text-foreground' : ''
          }`}
          title={showThumbs ? 'Hide thumbnails' : 'Show thumbnails'}
          aria-label="Toggle thumbnails"
        >
          {/* hamburger / page-list icon */}
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
            <line x1="4" y1="6" x2="20" y2="6" />
            <line x1="4" y1="12" x2="20" y2="12" />
            <line x1="4" y1="18" x2="20" y2="18" />
          </svg>
        </button>
        <span className="tabular-nums">
          {numPages > 0 ? `${currentPage} / ${numPages}` : '—'}
        </span>
        <div className="ml-auto flex items-center gap-1">
          <button
            onClick={zoomOut}
            className="px-1.5 py-0.5 rounded hover:bg-accent transition-colors"
            title="Zoom out"
            aria-label="Zoom out"
          >
            −
          </button>
          <button
            onClick={zoomReset}
            className="px-1.5 py-0.5 rounded hover:bg-accent transition-colors tabular-nums min-w-[3.5rem]"
            title="Fit width"
          >
            {Math.round(zoom * 100)}%
          </button>
          <button
            onClick={zoomIn}
            className="px-1.5 py-0.5 rounded hover:bg-accent transition-colors"
            title="Zoom in"
            aria-label="Zoom in"
          >
            +
          </button>
        </div>
      </div>
    ),
    [numPages, currentPage, zoom, zoomIn, zoomOut, zoomReset, showThumbs, toggleThumbs],
  );

  if (docState.kind === 'error') {
    return (
      <div className="h-full flex flex-col bg-secondary">
        {toolbar}
        <div className="flex-1 flex items-center justify-center">
          <div className="text-sm text-red-11">{docState.message}</div>
        </div>
      </div>
    );
  }

  return (
    <div className="h-full flex flex-col bg-secondary">
      {toolbar}
      <div className="flex-1 flex min-h-0">
        {showThumbs && doc && base && (
          <ThumbnailSidebar
            doc={doc}
            numPages={numPages}
            base={base}
            currentPage={currentPage}
            onSelect={handleSelectPage}
          />
        )}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-auto px-4 py-4">
          {docState.kind === 'loading' || !doc || pageW <= 0 ? (
            <div className="h-full flex items-center justify-center">
              <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            <div style={{ height: totalSize, width: '100%', position: 'relative' }}>
              {virtualItems.map((vi) => (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  className="absolute left-0 top-0 w-full flex justify-center"
                  style={{ transform: `translateY(${vi.start}px)`, paddingBottom: PAGE_GAP }}
                >
                  <PdfPage
                    doc={doc}
                    pageNumber={vi.index + 1}
                    scale={renderScale}
                    width={pageW}
                    height={pageH}
                  />
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * Left thumbnail rail (native-PDF-viewer style). Renders a virtualized column
 * of small page thumbnails from the SAME pdf.js document. Clicking a thumbnail
 * jumps the main view; the thumbnail matching the current page is highlighted
 * and auto-scrolled into view when the main view scrolls.
 */
function ThumbnailSidebar({
  doc,
  numPages,
  base,
  currentPage,
  onSelect,
}: {
  doc: PDFDocumentProxy;
  numPages: number;
  base: { w: number; h: number };
  currentPage: number;
  onSelect: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  const thumbScale = THUMB_W / base.w;
  const thumbH = base.h * thumbScale;
  const rowSize = thumbH + THUMB_LABEL_H + THUMB_GAP;

  const virtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => listRef.current,
    estimateSize: () => rowSize,
    overscan: 3,
  });

  // Keep the active thumbnail visible as the main view scrolls.
  useEffect(() => {
    if (numPages > 0) virtualizer.scrollToIndex(currentPage - 1, { align: 'auto' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentPage]);

  const items = virtualizer.getVirtualItems();

  return (
    <div
      ref={listRef}
      className="shrink-0 overflow-auto border-r border-border bg-secondary py-2"
      style={{ width: SIDEBAR_W }}
    >
      <div style={{ height: virtualizer.getTotalSize(), width: '100%', position: 'relative' }}>
        {items.map((vi) => {
          const active = currentPage === vi.index + 1;
          return (
            <div
              key={vi.key}
              className="absolute left-0 top-0 w-full flex flex-col items-center"
              style={{ transform: `translateY(${vi.start}px)`, paddingBottom: THUMB_GAP }}
            >
              <button
                onClick={() => onSelect(vi.index)}
                className={`rounded-sm overflow-hidden transition-shadow ${
                  active ? 'ring-2 ring-brand' : 'ring-1 ring-border hover:ring-muted-foreground'
                }`}
                title={`Page ${vi.index + 1}`}
                aria-label={`Go to page ${vi.index + 1}`}
              >
                <PdfPage
                  doc={doc}
                  pageNumber={vi.index + 1}
                  scale={thumbScale}
                  width={THUMB_W}
                  height={thumbH}
                />
              </button>
              <span
                className={`mt-0.5 text-[11px] tabular-nums leading-none ${
                  active ? 'text-foreground font-medium' : 'text-muted-foreground'
                }`}
                style={{ height: THUMB_LABEL_H }}
              >
                {vi.index + 1}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * Render a single PDF page onto a <canvas>. Only mounted for pages inside the
 * virtual window. The wrapper has an explicit CSS size so the row height is
 * stable before the canvas paints (no scroll jump), and the canvas backing
 * store is scaled by devicePixelRatio (capped at 2) for crisp text.
 */
function PdfPage({
  doc,
  pageNumber,
  scale,
  width,
  height,
}: {
  doc: PDFDocumentProxy;
  pageNumber: number;
  scale: number;
  width: number;
  height: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    let cancelled = false;
    let renderTask: { promise: Promise<void>; cancel: () => void } | null = null;

    (async () => {
      const page = await doc.getPage(pageNumber);
      if (cancelled) return;
      const canvas = canvasRef.current;
      if (!canvas) return;

      const dpr = Math.min(typeof window !== 'undefined' ? window.devicePixelRatio || 1 : 1, 2);
      const viewport = page.getViewport({ scale: scale * dpr });

      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;

      renderTask = page.render({ canvas, viewport });
      try {
        await renderTask.promise;
      } catch {
        /* render cancelled — expected on fast scroll / unmount */
      }
    })();

    return () => {
      cancelled = true;
      try {
        renderTask?.cancel();
      } catch {
        /* noop */
      }
    };
  }, [doc, pageNumber, scale, width, height]);

  return (
    <div className="bg-white shadow-md" style={{ width, height }}>
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
