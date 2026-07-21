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
/**
 * CSS px per PDF point (PDF is 72dpi, CSS is 96dpi). A render scale of exactly
 * CSS_UNITS is what every PDF viewer calls "100%" — the page at physical size.
 * Zoom factors below are expressed relative to that, NOT to raw pdf.js scale 1.
 */
const CSS_UNITS = 96 / 72;
/** Zoom bounds and step, as multiples of 100% (== CSS_UNITS). */
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
  /**
   * EVERY page's size in PDF points (scale 1), indexed by page-1.
   *
   * Page sizes are not uniform in general: a very common book layout is
   * single-width cover/back pages wrapping double-width landscape spreads.
   * Sizing all pages from page 1 squashes every page whose aspect ratio differs
   * from the cover's — a 792pt spread forced into a 396pt-wide box renders at
   * exactly 2x horizontal compression, which reads as "the font looks wrong"
   * rather than as a layout bug.
   */
  const [sizes, setSizes] = useState<{ w: number; h: number }[] | null>(null);
  const [containerWidth, setContainerWidth] = useState(0);
  /**
   * 'auto' == fit width, but never magnified past 100%. Fitting width alone
   * would blow a portrait page up to ~230% in a wide panel (A4 is 595pt vs a
   * ~1370px panel), which reads as "the font is huge"; landscape slide decks
   * (960pt) sit near the cap anyway, so they still fill the width as before.
   */
  const [zoomMode, setZoomMode] = useState<
    { kind: 'auto' } | { kind: 'fixed'; factor: number }
  >({ kind: 'auto' });
  const [currentPage, setCurrentPage] = useState(1);
  const [showThumbs, setShowThumbs] = useState(true);

  // ---- Load document (lazy pdf.js import keeps it out of SSR) ----
  useEffect(() => {
    let cancelled = false;
    setDocState({ kind: 'loading' });
    setDoc(null);
    setNumPages(0);
    setSizes(null);
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

        // Measure every page up front so the virtualizer's offsets are correct
        // from the first paint. This only reads each page's dictionary (no
        // content parsing or rasterizing), which is cheap next to rendering.
        const measured = await Promise.all(
          Array.from({ length: loaded.numPages }, (_, i) =>
            loaded.getPage(i + 1).then((p) => {
              const v = p.getViewport({ scale: 1 });
              return { w: v.width, h: v.height };
            }),
          ),
        );
        if (cancelled) return;

        setDoc(loaded);
        setNumPages(loaded.numPages);
        setSizes(measured);
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
  /** Fit the WIDEST page, so a mixed-size document never overflows horizontally. */
  const maxPageW = useMemo(
    () => (sizes?.length ? Math.max(...sizes.map((s) => s.w)) : 0),
    [sizes],
  );
  const fitScale = maxPageW > 0 && containerWidth > 0 ? containerWidth / maxPageW : CSS_UNITS;
  /** Auto = fit width, clamped so a page is never magnified beyond 100%. */
  const autoScale = Math.min(fitScale, CSS_UNITS);
  const renderScale = zoomMode.kind === 'auto' ? autoScale : zoomMode.factor * CSS_UNITS;
  /** What the toolbar shows: the TRUE zoom, so the label can't drift from what's on screen. */
  const zoomPercent = Math.round((renderScale / CSS_UNITS) * 100);
  /** Per-page row heights — pages may differ, so a single rowSize can't describe them. */
  const rowHeights = useMemo(
    () => (sizes ? sizes.map((s) => s.h * renderScale + PAGE_GAP) : []),
    [sizes, renderScale],
  );
  const contentW = maxPageW * renderScale;

  // Stepping from 'auto' needs the factor auto currently resolves to. A ref
  // keeps zoomIn/zoomOut referentially stable despite this changing on resize.
  const autoFactorRef = useRef(1);
  autoFactorRef.current = autoScale / CSS_UNITS;

  // ---- Virtualize pages ----
  const rowHeightsRef = useRef(rowHeights);
  rowHeightsRef.current = rowHeights;

  const rowVirtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => scrollRef.current,
    estimateSize: (i) => rowHeightsRef.current[i] ?? 0,
    overscan: 2,
  });

  // Recompute slot heights whenever page sizes or the zoom change.
  useEffect(() => {
    if (rowHeights.length > 0) rowVirtualizer.measure();
  }, [rowHeights, rowVirtualizer]);

  // Rows have different heights now, so the current page can't be divided out
  // of the scroll offset — ask the virtualizer which row the viewport top is in.
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el || numPages === 0) return;
    const top = el.scrollTop;
    const hit = rowVirtualizer.getVirtualItems().find((vi) => vi.end > top);
    setCurrentPage((hit ? hit.index : numPages - 1) + 1);
  }, [rowVirtualizer, numPages]);

  const stepZoom = useCallback((step: number) => {
    setZoomMode((m) => {
      const cur = m.kind === 'auto' ? autoFactorRef.current : m.factor;
      return { kind: 'fixed', factor: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, cur * step)) };
    });
  }, []);
  const zoomIn = useCallback(() => stepZoom(ZOOM_STEP), [stepZoom]);
  const zoomOut = useCallback(() => stepZoom(1 / ZOOM_STEP), [stepZoom]);
  const zoomReset = useCallback(() => setZoomMode({ kind: 'auto' }), []);
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
            className={`px-1.5 py-0.5 rounded hover:bg-accent transition-colors tabular-nums min-w-[3.5rem] ${
              zoomMode.kind === 'auto' ? '' : 'text-foreground'
            }`}
            title="Reset to automatic zoom"
          >
            {zoomPercent}%
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
    [
      numPages,
      currentPage,
      zoomPercent,
      zoomMode.kind,
      zoomIn,
      zoomOut,
      zoomReset,
      showThumbs,
      toggleThumbs,
    ],
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
        {showThumbs && doc && sizes && (
          <ThumbnailSidebar
            doc={doc}
            numPages={numPages}
            sizes={sizes}
            maxPageW={maxPageW}
            currentPage={currentPage}
            onSelect={handleSelectPage}
          />
        )}
        <div ref={scrollRef} onScroll={handleScroll} className="flex-1 overflow-auto px-4 py-4">
          {docState.kind === 'loading' || !doc || !sizes || contentW <= 0 ? (
            <div className="h-full flex items-center justify-center">
              <span className="inline-block w-6 h-6 border-2 border-brand border-t-transparent rounded-full animate-spin" />
            </div>
          ) : (
            // Width tracks the page once zoomed past the viewport: at width:100%
            // a wider centered page overflows both sides and its left half
            // becomes unreachable, since scrolling can't reveal overflow that
            // starts left of the origin.
            <div
              style={{
                height: totalSize,
                width: Math.max(contentW, containerWidth),
                position: 'relative',
              }}
            >
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
                    width={sizes[vi.index].w * renderScale}
                    height={sizes[vi.index].h * renderScale}
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
  sizes,
  maxPageW,
  currentPage,
  onSelect,
}: {
  doc: PDFDocumentProxy;
  numPages: number;
  sizes: { w: number; h: number }[];
  maxPageW: number;
  currentPage: number;
  onSelect: (index: number) => void;
}) {
  const listRef = useRef<HTMLDivElement>(null);

  // Scale off the widest page so the rail's width bounds every thumbnail; each
  // thumbnail then keeps its OWN aspect ratio (narrow covers stay narrow).
  const thumbScale = maxPageW > 0 ? THUMB_W / maxPageW : 0;
  const thumbHeights = useMemo(
    () => sizes.map((s) => s.h * thumbScale + THUMB_LABEL_H + THUMB_GAP),
    [sizes, thumbScale],
  );
  const thumbHeightsRef = useRef(thumbHeights);
  thumbHeightsRef.current = thumbHeights;

  const virtualizer = useVirtualizer({
    count: numPages,
    getScrollElement: () => listRef.current,
    estimateSize: (i) => thumbHeightsRef.current[i] ?? 0,
    overscan: 3,
  });

  useEffect(() => {
    if (thumbHeights.length > 0) virtualizer.measure();
  }, [thumbHeights, virtualizer]);

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
                  width={sizes[vi.index].w * thumbScale}
                  height={sizes[vi.index].h * thumbScale}
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
 *
 * `width`/`height` size the WRAPPER only. The canvas sizes itself from the
 * viewport it actually rendered, so a caller that miscomputes the wrapper can
 * never scale the page anisotropically — it would leave a visible gap or
 * overhang instead of silently squashing the glyphs.
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
      // Derive the CSS size from the backing store so the ratio is exactly dpr
      // on both axes: no anisotropic squash, and no fractional resampling.
      canvas.style.width = `${canvas.width / dpr}px`;
      canvas.style.height = `${canvas.height / dpr}px`;

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
    // width/height are wrapper-only now; re-rasterizing depends on scale alone.
  }, [doc, pageNumber, scale]);

  return (
    <div className="bg-white shadow-md" style={{ width, height }}>
      <canvas ref={canvasRef} className="block" />
    </div>
  );
}
