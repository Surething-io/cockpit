/**
 * Client hook for the Code Map's chip view.
 *
 * `useFileFunctions(cwd, filePath)` fetches the focal file's projection
 * (functions + intra-file calls + cross-file callers/callees). Cached
 * per (cwd, filePath) so flipping back and forth between focal files is
 * instant after the first visit. The server keeps the project-wide
 * CodeIndex hot per cwd. For a brand-new cwd the server does NOT wait for
 * that index (a full project parse — up to tens of seconds on monorepos):
 * it answers the file-local layer flagged `crossFilePending`, and the hook
 * refetches once the build's `done` frame arrives over `/ws/watch`.
 *
 * `invalidateBlocksCache(cwd)` is called when the user hits the manual
 * refresh button — drops every focal-file projection for that cwd so
 * the next fetch goes through to a freshly-rebuilt index.
 */

'use client';

import { useCallback, useEffect, useRef, useState } from 'react';
import type { FileFunctionsResponse } from '@cockpit/feature-explorer/server/codeMap/projectGraph/types';
// Wrap fetches in Effect while preserving the cache/inflight de-dup semantics below.
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

const ffCache = new Map<string, FileFunctionsResponse>();
const ffInflight = new Map<string, Promise<FileFunctionsResponse | 'not-found'>>();

const ffKey = (cwd: string, file: string) => `${cwd}::${file}`;

export function invalidateBlocksCache(cwd?: string): void {
  if (!cwd) {
    ffCache.clear();
    ffInflight.clear();
    return;
  }
  const prefix = `${cwd}::`;
  for (const k of ffCache.keys()) if (k.startsWith(prefix)) ffCache.delete(k);
  for (const k of ffInflight.keys()) if (k.startsWith(prefix)) ffInflight.delete(k);
}

async function fetchFileFunctions(
  cwd: string,
  filePath: string,
  forceRefresh = false,
): Promise<FileFunctionsResponse | 'not-found'> {
  const k = ffKey(cwd, filePath);
  if (!forceRefresh) {
    const cached = ffCache.get(k);
    if (cached) return cached;
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
      const res = await fetch(`/api/projectGraph/file-functions?${params}`);
      if (res.status === 404) return 'not-found' as const;
      if (!res.ok) {
        const data = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
        throw new Error(data.error || `HTTP ${res.status}`);
      }
      const json = (await res.json()) as FileFunctionsResponse;
      // A partial (file-local) answer must not satisfy later lookups once
      // the index is ready — cache only the full projection.
      if (!json.crossFilePending) ffCache.set(k, json);
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
    .finally(() => ffInflight.delete(k));
  ffInflight.set(k, req);
  return req;
}

export function useFileFunctions(cwd: string, filePath: string | null) {
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

  /** `silent`: upgrade data already on screen (pending → full projection)
   *  without flashing the loading state, and keep that data if it fails. */
  const run = useCallback(
    (cwd: string, file: string, forceRefresh: boolean, silent = false) => {
      const k = ffKey(cwd, file);
      latestKeyRef.current = k;
      if (!silent) setState({ state: 'loading' });
      fetchFileFunctions(cwd, file, forceRefresh)
        .then((result) => {
          if (!mountedRef.current || latestKeyRef.current !== k) return;
          if (result === 'not-found') setState({ state: 'notFound' });
          else setState({ state: 'ready', data: result });
        })
        .catch((err: Error) => {
          if (!mountedRef.current || latestKeyRef.current !== k || silent) return;
          setState({ state: 'error', message: err.message });
        });
    },
    [],
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

  // Cross-file layer still building server-side: refetch on its `done`
  // frame (sent on failure too — the server then answers without the flag).
  const crossFilePending = state.state === 'ready' && state.data.crossFilePending === true;
  const onWatchMessage = useCallback(
    (msg: unknown) => {
      const m = msg as { type?: string; data?: { cwd?: string; phase?: string } };
      if (m?.type !== 'graphProgress' || m.data?.cwd !== cwd || m.data.phase !== 'done') return;
      if (filePath) run(cwd, filePath, false, true);
    },
    [cwd, filePath, run],
  );
  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd)}`,
    onMessage: onWatchMessage,
    enabled: crossFilePending,
  });
  // Subscribe, then check once: a build that finished between the response
  // and the subscription above sends no further `done`. Must run after
  // useWebSocket's effect, hence declared below it.
  useEffect(() => {
    if (crossFilePending && filePath) run(cwd, filePath, false, true);
  }, [crossFilePending, cwd, filePath, run]);

  return { state, refresh };
}
