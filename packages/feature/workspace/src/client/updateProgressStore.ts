'use client';

/**
 * Self-update progress, held OUTSIDE React.
 *
 * The update outlives the component that started it: the trigger lives in the
 * sidebar's version popover, which unmounts the moment the popover closes or
 * the sidebar collapses. State kept in that component died with it, which is
 * why the old flow could only show a spinner on the button itself. Here the
 * store is module-level (same pattern as SessionCompleteToast) and
 * UpdateProgressCard merely subscribes.
 *
 * Three sources feed it, in descending order of fidelity:
 *
 *   1. the updater's loopback status port  — live, only while the server is down
 *   2. /api/health pid change              — the completion signal, always works
 *   3. /api/update-state                   — the baseline before, the outcome after
 *
 * Source 1 is best-effort. Everything degrades to 2 + a local timer.
 *
 * Plain fetch rather than the Effect runtime, matching useLatestVersion: these
 * client-side probes sit outside EFFECT.md's enforced globs (src/app/api/**,
 * src/lib/effect/**). They also have to survive the server being absent, which
 * is not a failure mode the shared runtime models.
 */

export type UpdateStage =
  | 'preparing'
  | 'installing'
  | 'repairing'
  | 'rolling-back'
  | 'restarting'
  | 'done'
  | 'failed';

export interface UpdateProgressState {
  readonly visible: boolean;
  readonly stage: UpdateStage;
  /** Client clock, drives the elapsed counter. */
  readonly startedAt: number;
  /** Previous run's install duration — the only honest "how long" estimate. */
  readonly baselineMs: number | null;
  readonly installedVersion: string | null;
  /** npm had nothing newer — say "already up to date", not "updated to". */
  readonly upToDate: boolean;
  readonly error: string | null;
  readonly rolledBack: boolean;
  /** Shell command that fixes this particular failure. */
  readonly fixCommand: string;
  readonly logPath: string | null;
  /** False once the status channel is given up on; the card says so. */
  readonly live: boolean;
}

/** What to fall back to when the updater did not name a more specific fix. */
const DEFAULT_FIX = 'cockpit update';

const IDLE: UpdateProgressState = {
  visible: false,
  stage: 'preparing',
  startedAt: 0,
  baselineMs: null,
  installedVersion: null,
  upToDate: false,
  error: null,
  rolledBack: false,
  fixCommand: DEFAULT_FIX,
  logPath: null,
  live: false,
};

const POLL_MS = 1000;
/** The updater installs, may roll back (a second full install), and respawns. */
const WAIT_TIMEOUT_MS = 5 * 60_000;
/** Give up on the status port after this many consecutive misses, not the first:
 *  the updater binds it a beat after we get the response. */
const MAX_STATUS_MISSES = 3;
/** A state file older than this describes an update nobody is waiting on. */
const STALE_MS = 10 * 60_000;
/** Marks the last failure the user has acknowledged, so it stops reappearing. */
const SEEN_KEY = 'cockpit:update-seen-at';

let state: UpdateProgressState = IDLE;
const listeners = new Set<() => void>();
/** Guards a double-click: the second update would race the first's shutdown. */
let running = false;

function set(patch: Partial<UpdateProgressState>): void {
  state = { ...state, ...patch };
  listeners.forEach((l) => l());
}

export function subscribeUpdateProgress(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function getUpdateProgress(): UpdateProgressState {
  return state;
}

export function dismissUpdateProgress(): void {
  try {
    window.localStorage.setItem(SEEN_KEY, String(Date.now()));
  } catch { /* private mode — worst case the card reappears once */ }
  set({ visible: false });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Health {
  readonly pid: number | null;
  readonly version: string | null;
}

async function readHealth(): Promise<Health | null> {
  try {
    const res = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: number; version?: string };
    return {
      pid: typeof body.pid === 'number' ? body.pid : null,
      version: body.version ?? null,
    };
  } catch {
    return null;
  }
}

interface UpdaterState {
  readonly phase?: string;
  readonly error?: string;
  readonly installed?: string;
  readonly installMs?: number;
  readonly prevInstallMs?: number;
  readonly rolledBack?: boolean;
  readonly unchanged?: boolean;
  readonly fixCommand?: string;
  readonly startedAt?: number;
  readonly finishedAt?: number;
}

/** The on-disk record, via the main port. Only reachable when a server is up. */
async function readRecordedState(): Promise<{ state: UpdaterState | null; logPath: string | null }> {
  try {
    const res = await fetch('/api/update-state', {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return { state: null, logPath: null };
    const body = (await res.json()) as { state?: UpdaterState | null; logPath?: string };
    return { state: body.state ?? null, logPath: body.logPath ?? null };
  } catch {
    return { state: null, logPath: null };
  }
}

/** The live record, via the updater's loopback port. Only while the server is down. */
async function readLiveState(port: number): Promise<UpdaterState | null> {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/`, {
      cache: 'no-store',
      signal: AbortSignal.timeout(1500),
    });
    if (!res.ok) return null;
    return (await res.json()) as UpdaterState;
  } catch {
    return null;
  }
}

/**
 * The updater's `restarting` and `done` both mean "the replacement was
 * spawned", not "it is listening". Neither is reported as finished here — only
 * a changed pid on /api/health is, or the reload button would hand the user a
 * dead page.
 */
function stageFromPhase(phase: string | undefined): UpdateStage {
  switch (phase) {
    case 'installing':
      return 'installing';
    case 'repairing':
      return 'repairing';
    case 'rolling-back':
      return 'rolling-back';
    case 'restarting':
    case 'done':
      return 'restarting';
    default:
      return 'preparing';
  }
}

function applyLive(live: UpdaterState): void {
  set({
    stage: stageFromPhase(live.phase),
    installedVersion: live.installed ?? state.installedVersion,
    baselineMs: state.baselineMs ?? live.prevInstallMs ?? null,
  });
}

function fail(error: string, extra: Partial<UpdateProgressState> = {}): void {
  set({ stage: 'failed', error, ...extra });
}

export async function startSelfUpdate(): Promise<void> {
  if (running) return;
  running = true;

  set({
    ...IDLE,
    visible: true,
    stage: 'preparing',
    startedAt: Date.now(),
  });

  try {
    // Baseline BEFORE the POST: the updater overwrites update-state.json within
    // milliseconds of starting, taking the previous run's timing with it.
    const recorded = await readRecordedState();
    set({
      baselineMs: recorded.state?.installMs ?? recorded.state?.prevInstallMs ?? null,
      logPath: recorded.logPath,
    });

    const before = await readHealth();
    const pidBefore = before?.pid ?? null;
    const versionBefore = before?.version ?? null;

    const res = await fetch('/api/update', { method: 'POST' });
    if (!res.ok) {
      // Refusals arrive as { error, tag }: 403 non-local, 400 dev mode.
      const body = (await res.json().catch(() => ({}))) as { error?: string };
      fail(body.error ?? `HTTP ${res.status}`);
      return;
    }
    const body = (await res.json().catch(() => ({}))) as {
      statusPort?: number | null;
      logPath?: string;
    };
    const statusPort = body.statusPort ?? null;
    set({ logPath: body.logPath ?? state.logPath });

    let misses = 0;
    let useStatus = statusPort !== null;
    const deadline = Date.now() + WAIT_TIMEOUT_MS;

    while (Date.now() < deadline) {
      await sleep(POLL_MS);

      if (useStatus && statusPort !== null) {
        const live = await readLiveState(statusPort);
        if (live) {
          misses = 0;
          set({ live: true });
          if (live.phase === 'failed') {
            // The whole point of the channel: a failed install is followed by a
            // rollback, i.e. a SECOND full npm install. Without this the card
            // would sit on "installing" for double the time and only then admit
            // failure.
            fail(live.error ?? 'install failed', {
              rolledBack: live.rolledBack === true,
              fixCommand: live.fixCommand ?? DEFAULT_FIX,
              live: true,
            });
            return;
          }
          applyLive(live);
        } else if (++misses >= MAX_STATUS_MISSES) {
          useStatus = false;
          set({ live: false });
        }
      }

      const health = await readHealth();
      // A DIFFERENT pid means the replacement is serving us. If the old pid was
      // never learned, any answer will do.
      if (health?.pid != null && (pidBefore === null || health.pid !== pidBefore)) {
        // A changed pid only proves the server came back, not that the update
        // was clean — an install that dropped the native Claude binary
        // restarts perfectly and reports `failed`. With the status channel
        // that was caught above; in degraded mode this re-read is the only
        // thing standing between the user and a green "update complete" on a
        // Cockpit that cannot chat. The server is up by now, so the
        // authoritative record is readable again.
        const { state: recorded } = await readRecordedState();
        if (recorded?.phase === 'failed') {
          fail(recorded.error ?? 'update failed', {
            rolledBack: recorded.rolledBack === true,
            fixCommand: recorded.fixCommand ?? DEFAULT_FIX,
          });
          return;
        }

        const installedVersion = health.version ?? state.installedVersion;
        set({
          stage: 'done',
          installedVersion,
          // Compared here rather than read from the updater's `unchanged` flag
          // so it still works in degraded mode, where the status channel never
          // delivered anything. Both sides come from /api/health, so they are
          // the same field measured before and after.
          upToDate: installedVersion !== null && installedVersion === versionBefore,
        });
        return;
      }
    }

    fail('timeout');
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    running = false;
  }
}

/**
 * Re-attach after a page reload.
 *
 * The card's in-memory state does not survive a reload, but a FAILED update
 * must — losing it with the old page is how a user ends up on a stale version
 * with no idea why. Called once, from the card.
 */
export async function restoreUpdateProgress(): Promise<void> {
  if (running || state.visible) return;

  const { state: recorded, logPath } = await readRecordedState();
  if (!recorded?.phase) return;
  // Restarts share the state file and are not worth a card.
  if (recorded.phase === 'done') return;

  const startedAt = recorded.startedAt ?? 0;
  const baselineMs = recorded.installMs ?? recorded.prevInstallMs ?? null;

  if (recorded.phase === 'failed') {
    let seenAt = 0;
    try {
      seenAt = Number(window.localStorage.getItem(SEEN_KEY)) || 0;
    } catch { /* private mode */ }
    if ((recorded.finishedAt ?? 0) <= seenAt) return;

    set({
      ...IDLE,
      visible: true,
      stage: 'failed',
      startedAt,
      baselineMs,
      error: recorded.error ?? 'unknown error',
      rolledBack: recorded.rolledBack === true,
      fixCommand: recorded.fixCommand ?? DEFAULT_FIX,
      logPath,
    });
    return;
  }

  // Non-terminal. This page was served by SOME server, so the update is either
  // still running under a stale record or the updater died mid-way; either way
  // the main port can be polled for the outcome. Anything older than STALE_MS
  // is nobody's live update.
  if (!startedAt || Date.now() - startedAt > STALE_MS) return;

  running = true;
  set({
    ...IDLE,
    visible: true,
    stage: stageFromPhase(recorded.phase),
    startedAt,
    baselineMs,
    logPath,
  });

  try {
    const deadline = startedAt + WAIT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      await sleep(POLL_MS);
      const { state: latest } = await readRecordedState();
      if (!latest?.phase) continue;
      if (latest.phase === 'failed') {
        fail(latest.error ?? 'install failed', {
          rolledBack: latest.rolledBack === true,
          fixCommand: latest.fixCommand ?? DEFAULT_FIX,
        });
        return;
      }
      if (latest.phase === 'done') {
        set({
          stage: 'done',
          installedVersion: latest.installed ?? null,
          // No before/after health reading survived the reload, so here the
          // updater's own flag is the only source.
          upToDate: latest.unchanged === true,
        });
        return;
      }
      set({ stage: stageFromPhase(latest.phase) });
    }
    fail('timeout');
  } finally {
    running = false;
  }
}
