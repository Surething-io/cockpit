// V8 heap ceiling for the server process.
//
// Node's default (~4 GB) unless the user asks for more. This used to raise the
// limit to a quarter of RAM (16 GB on a 64 GB machine) so the Code Map could
// cache more. It did, and that was the problem: five large worktrees stayed
// resident at once, 7.3 GB live, and each full GC paused the main thread for
// ~3 s — every request on the server stalled behind it. The Code Map now has
// its own hard cap and an idle sweep (codeIndex.ts), so the default heap is
// enough, and a smaller heap keeps GC pauses short.
//
// An explicit `--max-old-space-size` in NODE_OPTIONS wins; COCKPIT_MAX_HEAP_MB
// sets the limit for this server only.

/** Node CLI args that set the server's heap limit; empty = Node's default. */
export function heapArgs(env = process.env) {
  if (/--max-old-space-size/.test(env.NODE_OPTIONS ?? '')) return [];
  const override = Number(env.COCKPIT_MAX_HEAP_MB);
  return override > 0 ? [`--max-old-space-size=${Math.floor(override)}`] : [];
}
