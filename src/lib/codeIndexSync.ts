/**
 * codeIndexSync — wires the project file watcher to the in-memory code index.
 *
 * codeIndex.ts lives in @cockpit/feature-explorer (a package) and intentionally
 * doesn't know about /src/lib/fileWatcher (the app). This module bridges them:
 *
 *   1. `wireCodeIndexToFileWatcher` is called ONCE at server boot, passing a
 *      closure that knows how to subscribe to fileWatcher per cwd.
 *   2. codeIndex calls back into this closure on first `getCodeIndex(cwd)` for
 *      each new cwd. We invoke `fileWatcher.subscribe(cwd, ...)`.
 *   3. Events advance the project's pending version; they never parse files.
 *      A project query verifies Git membership and source fingerprints, then
 *      atomically publishes a consistent revision. The index owner releases
 *      the subscription when its cache entry is evicted.
 *
 * Exported as a named function (instead of a side-effect import) so that
 * webpack / esbuild can't tree-shake away the registration call. Caller in
 * src/lib/wsServer.ts invokes it once at boot.
 */

import { registerWatcherSubscriber, startCodeIndexIdleSweeper } from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';
import { fileWatcher } from './fileWatcher';

let wired = false;

export function wireCodeIndexToFileWatcher(): void {
  // Idempotent — webpack HMR / Next.js dual-bundle topology can call us twice.
  if (wired) return;
  wired = true;

  // Release Code Map indexes nobody has read for a while (see
  // evictIdleCodeIndexes). Started here because this runs exactly once at boot.
  startCodeIndexIdleSweeper();

  registerWatcherSubscriber((cwd, onDirty) => {
    return fileWatcher.subscribe(cwd, (events) => {
      // The watcher emits 'file' (working-tree change) and 'git' (HEAD/refs
      // move). 'file' implies source content changed. 'git' also implies
      // content may differ (checkout / merge moves files).
      if (events.some((e) => e.type === 'file' || e.type === 'git')) {
        onDirty();
      }
    });
  });
}
