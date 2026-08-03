/**
 * buildProgress — progress reporting for `buildCodeIndex`.
 *
 * Why this exists: a full index build is a multi-second, occasionally
 * multi-TEN-second operation (measured: 2.0s @ 255 files, 8.0s @ 4.5k files,
 * 17.9s @ 7.7k files), and until it resolves the Code Map can only show a
 * spinner. This module lets the build narrate itself so the UI can render a
 * real progress bar instead.
 *
 * Delivery: `src/lib/effect/fileWatchHandler.ts` subscribes and forwards
 * frames over the ALREADY-OPEN `/ws/watch?cwd=` socket that FileBrowserModal
 * holds. No new route, no polling. The direction is app → package (the app
 * imports us), which is the allowed dependency direction, so unlike
 * `registerWatcherSubscriber` this needs no inversion-of-control dance.
 *
 * Why pushing progress works at all: the parse phase is `await readFile` +
 * sync parse per file, so the event loop is only ever blocked for one file at
 * a time. Measured during a live build, an unrelated request saw p50=89ms /
 * max=200ms latency and zero stalls over 500ms — roughly 7.6 round-trips per
 * second, which is more than a progress bar needs. If the build ever becomes
 * one long synchronous block, frames would bunch up and the bar would freeze;
 * that would be the signal to move parsing to a worker thread.
 */

/** Build phases, in execution order. `parsing` is the only one with per-file
 *  granularity — the rest are short synchronous passes (each well under the
 *  200ms worst case above), so they report as indeterminate steps. */
export type BuildPhase =
  | 'listing'
  | 'contexts'
  | 'parsing'
  | 'resolving'
  | 'edges'
  | 'done';

export interface BuildProgressEvent {
  cwd: string;
  phase: BuildPhase;
  /** Files parsed so far. Only meaningful while `phase === 'parsing'`. */
  filesDone: number;
  /** Total files to parse. 0 until the listing phase completes. */
  filesTotal: number;
  /** Most recently parsed file (project-relative). Absent outside `parsing`. */
  currentFile?: string;
  /** 0-100, weighted across phases. See `percentFor`. */
  percent: number;
}

type Listener = (ev: BuildProgressEvent) => void;

// ────────────────────────────────────────────────────────────────────────────
// State is pinned to globalThis, and it MUST be.
//
// This module is instantiated TWICE. `server.mjs` runs under tsx and imports
// `src/lib/wsServer.ts` → fileWatchHandler → this file through Node's module
// registry, while the API routes reach it through Next's webpack bundle
// (`@cockpit/feature-explorer` is in `transpilePackages`, so it is compiled
// IN, not externalized). Two realms, two module instances, two sets of
// module-level `Map`s.
//
// The subscriber lives in the server.mjs realm and the emitter lives in the
// route realm — the one pairing where the existing "just call it from both
// sides" workaround (see `wireCodeIndexToFileWatcher`) cannot help. Without
// globalThis the WS handler subscribes to one Map while the build emits into
// the other, and progress silently never arrives. That is exactly what the
// first end-to-end run produced: zero frames.
//
// Same pattern as `src/lib/globalStateBroadcast.ts`, `src/lib/fileWatcher.ts`
// and `lsp/LSPServerRegistry.ts`, which all cross the same realm boundary.
// ────────────────────────────────────────────────────────────────────────────
interface ProgressGlobals {
  __cockpitGraphProgressListeners?: Map<string, Set<Listener>>;
  __cockpitGraphProgressLastFrame?: Map<string, BuildProgressEvent>;
  __cockpitGraphProgressLastEmitAt?: Map<string, number>;
}
const g = globalThis as unknown as ProgressGlobals;

const listeners: Map<string, Set<Listener>> =
  g.__cockpitGraphProgressListeners ??
  (g.__cockpitGraphProgressListeners = new Map());
/** Last frame per cwd, so a UI that mounts mid-build renders immediately
 *  instead of waiting up to a throttle window for the next frame. Deleted
 *  on `done` — a stale snapshot would make the next build look pre-started. */
const lastFrame: Map<string, BuildProgressEvent> =
  g.__cockpitGraphProgressLastFrame ??
  (g.__cockpitGraphProgressLastFrame = new Map());
/** Throttle bookkeeping per cwd. */
const lastEmitAt: Map<string, number> =
  g.__cockpitGraphProgressLastEmitAt ??
  (g.__cockpitGraphProgressLastEmitAt = new Map());

/** Per-file frames are throttled to this interval. Phase transitions and the
 *  terminal `done` frame always go out, so the client can't miss a state
 *  change by falling in a throttle gap. 100ms ≈ 10 fps, comfortably inside
 *  the ~7.6 req/s the event loop sustains mid-build and far below the ~330
 *  files/s parse rate (which would otherwise emit unreadable path spam). */
const THROTTLE_MS = 100;

/** Phase → [start, end] of the percentage range it owns. Parsing gets the
 *  lion's share because it IS the lion's share of wall-clock; the tail
 *  phases get a visible-but-small slice so the bar doesn't sit at 100%
 *  while work is still happening (a bar that reaches 100% and then waits
 *  reads as "stuck" — worse than one that reaches 85% and keeps moving). */
const PHASE_RANGE: Record<BuildPhase, [number, number]> = {
  listing: [0, 3],
  contexts: [3, 6],
  parsing: [6, 85],
  resolving: [85, 92],
  edges: [92, 99],
  done: [100, 100],
};

function percentFor(phase: BuildPhase, done: number, total: number): number {
  const [lo, hi] = PHASE_RANGE[phase];
  if (phase !== 'parsing' || total <= 0) return lo;
  return Math.min(hi, lo + ((hi - lo) * done) / total);
}

export function subscribeBuildProgress(cwd: string, fn: Listener): () => void {
  let set = listeners.get(cwd);
  if (!set) {
    set = new Set();
    listeners.set(cwd, set);
  }
  set.add(fn);
  // Replay the current frame so a late subscriber isn't blank until the
  // next throttle tick.
  const snapshot = lastFrame.get(cwd);
  if (snapshot) {
    try {
      fn(snapshot);
    } catch {
      /* a broken listener must not abort subscription */
    }
  }
  return () => {
    const s = listeners.get(cwd);
    if (!s) return;
    s.delete(fn);
    if (s.size === 0) listeners.delete(cwd);
  };
}

/**
 * Emit a progress frame. Called from `buildCodeIndex`.
 *
 * `force` bypasses the throttle — used for phase transitions and `done`.
 * Deliberately never throws: progress reporting must not be able to fail a
 * build. A listener that throws is swallowed and the rest still run.
 */
export function emitBuildProgress(
  cwd: string,
  phase: BuildPhase,
  filesDone = 0,
  filesTotal = 0,
  currentFile?: string,
  force = false,
): void {
  const set = listeners.get(cwd);
  const now = Date.now();

  if (!force) {
    const prev = lastEmitAt.get(cwd) ?? 0;
    if (now - prev < THROTTLE_MS) return;
  }
  lastEmitAt.set(cwd, now);

  const ev: BuildProgressEvent = {
    cwd,
    phase,
    filesDone,
    filesTotal,
    ...(currentFile ? { currentFile } : {}),
    percent: percentFor(phase, filesDone, filesTotal),
  };

  if (phase === 'done') {
    lastFrame.delete(cwd);
    lastEmitAt.delete(cwd);
  } else {
    lastFrame.set(cwd, ev);
  }

  // Keep the snapshot bookkeeping above even with no listeners — the UI may
  // subscribe mid-build and expects to replay the current frame.
  if (!set || set.size === 0) return;
  for (const fn of set) {
    try {
      fn(ev);
    } catch {
      /* ignore */
    }
  }
}
