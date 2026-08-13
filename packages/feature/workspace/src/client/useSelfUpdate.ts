'use client';

/**
 * Drive a self-update from the UI: POST /api/update, then wait for the server
 * to come back.
 *
 * No progress channel is needed. The server hands off to a detached updater and
 * exits, so any socket we hold dies with it; polling /api/health afterwards is
 * both simpler and more honest than trying to stream logs from a process that
 * is deliberately outliving its parent.
 *
 * Completion is detected by a CHANGED pid, not by "health answers". The
 * endpoint delays its exit by ~300ms so the response can flush, so an immediate
 * poll would hit the still-running old process and report success instantly.
 *
 * Plain fetch rather than the Effect runtime, matching useLatestVersion — these
 * client-side probes sit outside EFFECT.md's enforced globs (src/app/api/**,
 * src/lib/effect/**).
 */
import { useCallback, useRef, useState } from 'react';

export type UpdatePhase = 'idle' | 'starting' | 'waiting' | 'done' | 'failed';

/** The updater installs, may roll back, and respawns — all well under this. */
const WAIT_TIMEOUT_MS = 5 * 60_000;
const POLL_INTERVAL_MS = 1000;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function readPid(): Promise<number | null> {
  try {
    const res = await fetch('/api/health', {
      cache: 'no-store',
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const body = (await res.json()) as { pid?: number };
    return typeof body.pid === 'number' ? body.pid : null;
  } catch {
    return null;
  }
}

export function useSelfUpdate() {
  const [phase, setPhase] = useState<UpdatePhase>('idle');
  const [error, setError] = useState<string | null>(null);
  // Guards against a double-click firing two updates: the second would race the
  // first's shutdown and hit a server that is already going away.
  const runningRef = useRef(false);

  const start = useCallback(async () => {
    if (runningRef.current) return;
    runningRef.current = true;
    setError(null);
    setPhase('starting');

    try {
      const pidBefore = await readPid();

      const res = await fetch('/api/update', { method: 'POST' });
      if (!res.ok) {
        // The handler reports refusals as { error, tag } — a non-local caller
        // (403) or dev mode (400).
        const body = (await res.json().catch(() => ({}))) as { error?: string };
        setError(body.error ?? `HTTP ${res.status}`);
        setPhase('failed');
        return;
      }

      setPhase('waiting');
      const deadline = Date.now() + WAIT_TIMEOUT_MS;
      while (Date.now() < deadline) {
        await sleep(POLL_INTERVAL_MS);
        const pid = await readPid();
        // A different pid means the replacement server is serving us. If we
        // never learned the old pid, any answer is good enough.
        if (pid !== null && (pidBefore === null || pid !== pidBefore)) {
          setPhase('done');
          return;
        }
      }

      // The updater writes its own outcome to <cockpitHome>/update-state.json
      // and logs/updater.log; surface where to look rather than guessing.
      setError('timeout');
      setPhase('failed');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setPhase('failed');
    } finally {
      runningRef.current = false;
    }
  }, []);

  return { phase, error, start };
}
