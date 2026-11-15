/**
 * Fetch current focal-file projections, coalescing only concurrent requests.
 * Symbol previews stay local. Graph views request project relations on demand;
 * completion reads only observe the published revision, avoiding build loops.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileFunctionsResponse } from '@cockpit/feature-explorer/server/codeMap/projectGraph/types';
// Effect preserves tagged failures; the map below only coalesces in-flight IO.
import { Effect } from 'effect';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { AppError } from '@cockpit/effect-core';
import { useWebSocket } from '@cockpit/shared-ui';

export type FileFunctionsState =
  | { state: 'idle' }
  | { state: 'loading' }
  | { state: 'ready'; data: FileFunctionsResponse }
  | { state: 'notFound' }
  | { state: 'error'; message: string };

const ffInflight = new Map<string, Promise<FileFunctionsResponse | 'not-found'>>();

const ffKey = (cwd: string, file: string, relations = false) => `${cwd}::${relations ? 'project' : 'file'}::${file}`;

export function invalidateBlocksCache(cwd?: string): void {
  if (!cwd) {
    ffInflight.clear();
    return;
  }
  const prefix = `${cwd}::`;
  for (const k of ffInflight.keys()) if (k.startsWith(prefix)) ffInflight.delete(k);
}

async function fetchFileFunctions(
  cwd: string,
  filePath: string,
  forceRefresh = false,
  includeRelations = false,
): Promise<FileFunctionsResponse | 'not-found'> {
  const k = ffKey(cwd, filePath, includeRelations);
  if (!forceRefresh) {
    const pending = ffInflight.get(k);
    if (pending) return pending;
  } else {
    invalidateBlocksCache(cwd);
  }
  // Effect wrapper: status 404 -> 'not-found'; 4xx throws the inner Error via cause.
  // Note: to keep the `.catch((err: Error) => err.message)` semantics intact, when
  // runPromise fails we rethrow AppError.cause (the original Error) instead of
  // letting a FiberFailure leak out.
  const fetchEff: Effect.Effect<FileFunctionsResponse | 'not-found', AppError> = Effect.tryPromise({
    try: async () => {
      const params = new URLSearchParams({ cwd, path: filePath });
      if (forceRefresh) params.set('refresh', '1');
      if (includeRelations) params.set('relations', '1');
      const res = await fetch(`/api/projectGraph/file-functions?${params}`);
      if (res.status === 404) return 'not-found' as const;
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as FileFunctionsResponse;
      return json;
    },
    catch: (cause) => new AppError({ message: 'fetchFileFunctions failed', cause }),
  });
  const req = BrowserRuntime.runPromiseExit(fetchEff)
    .then((exit) => {
      if (exit._tag === 'Success') return exit.value;
      // Extract the innermost Error and rethrow it so the downstream
      // `.catch((err: Error) => err.message)` keeps its existing semantics.
      const failure = exit.cause._tag === 'Fail' ? exit.cause.error : null;
      const inner = failure?.cause;
      if (inner instanceof Error) throw inner;
      throw new Error(failure?.message ?? 'fetchFileFunctions failed');
    })
    .finally(() => { if (ffInflight.get(k) === req) ffInflight.delete(k); });
  ffInflight.set(k, req);
  return req;
}

export function useFileFunctions(cwd: string, filePath: string | null, includeRelations = false) {
  const [state, setState] = useState<FileFunctionsState>({ state: 'idle' });
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Latest requested (cwd, file). A response for anything else is stale —
  // the focal file moved on while it was in flight.
  const latestKeyRef = useRef('');
  const latestRequestRef = useRef(0);

  /** `silent`: upgrade data already on screen (pending → full projection)
   *  without flashing the loading state, and keep that data if it fails. */
  const run = useCallback(
    (cwd: string, file: string, forceRefresh: boolean, silent = false, queryRelations = includeRelations) => {
      const k = ffKey(cwd, file, includeRelations);
      latestKeyRef.current = k;
      const request = ++latestRequestRef.current;
      if (!silent) setState({ state: 'loading' });
      fetchFileFunctions(cwd, file, forceRefresh, queryRelations)
        .then((result) => {
          if (!mountedRef.current || latestKeyRef.current !== k || latestRequestRef.current !== request) return;
          if (result === 'not-found') setState({ state: 'notFound' });
          else setState({ state: 'ready', data: result });
        })
        .catch((err: Error) => {
          if (!mountedRef.current || latestKeyRef.current !== k || latestRequestRef.current !== request || silent) return;
          setState({ state: 'error', message: err.message });
        });
    },
    [includeRelations],
  );

  useEffect(() => {
    if (!cwd || !filePath) {
      setState({ state: 'idle' });
      return;
    }
    run(cwd, filePath, false);
  }, [cwd, filePath, run]);

  const refresh = useCallback(() => {
    if (!cwd || !filePath) return;
    run(cwd, filePath, true);
  }, [cwd, filePath, run]);

  const reload = useCallback(() => {
    if (cwd && filePath) run(cwd, filePath, false, true);
  }, [cwd, filePath, run]);

  // Cross-file layer still building server-side: refetch on its `done`
  // frame (sent on failure too — the server then answers without the flag).
  const crossFilePending = state.state === 'ready' && state.data.crossFilePending === true;
  const reloadAfterBuild = useCallback(() => {
    // A completion frame can arrive while the previous response is in flight.
    // Do not coalesce this read with the request that observed the old revision.
    invalidateBlocksCache(cwd);
    if (filePath) run(cwd, filePath, false, true, false);
  }, [cwd, filePath, run]);
  const onWatchMessage = useCallback(
    (msg: unknown) => {
      const m = msg as { type?: string; data?: { cwd?: string; phase?: string } };
      if (m?.type !== 'graphProgress' || m.data?.cwd !== cwd || m.data.phase !== 'done') return;
      reloadAfterBuild();
    },
    [cwd, reloadAfterBuild],
  );
  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: onWatchMessage,
    // Check after the socket is open, rather than after merely starting its
    // handshake. This also recovers completion frames lost while disconnected.
    onOpen: reloadAfterBuild,
    enabled: crossFilePending,
  });

  return { state, refresh, reload };
}
