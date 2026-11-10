// V8 heap ceiling for the server process.
//
// Node's default old-space limit is ~4 GB regardless of how much RAM the
// machine has, and the Code Map caches are budgeted against whatever limit the
// process actually got (see MAX_CACHED_SYMBOLS in codeIndex.ts). A fixed 4 GB
// is what let two large projects OOM the server on a 64 GB machine.
//
// A quarter of physical memory, capped at 16 GB. Below 16 GB of RAM the quarter
// would undercut Node's own default, so no flag is passed at all.
import os from 'node:os';

const MIN_MB = 4096;
const MAX_MB = 16384;

/** Heap limit in MB for a machine with `totalBytes` of RAM, or null to keep Node's default. */
export function heapLimitMb(totalBytes = os.totalmem()) {
  const quarter = Math.floor(totalBytes / 4 / 1024 / 1024);
  if (quarter <= MIN_MB) return null;
  return Math.min(quarter, MAX_MB);
}

/**
 * Node CLI args that set the server's heap limit. An explicit
 * `--max-old-space-size` in NODE_OPTIONS wins; COCKPIT_MAX_HEAP_MB overrides
 * the computed value.
 */
export function heapArgs(env = process.env, totalBytes = os.totalmem()) {
  if (/--max-old-space-size/.test(env.NODE_OPTIONS ?? '')) return [];
  const override = Number(env.COCKPIT_MAX_HEAP_MB);
  const mb = override > 0 ? Math.floor(override) : heapLimitMb(totalBytes);
  return mb ? [`--max-old-space-size=${mb}`] : [];
}
