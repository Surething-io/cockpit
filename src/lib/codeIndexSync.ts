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
 *   3. When fileWatcher fires a file-change event for that cwd, we flip the
 *      cwd's dirty bit by invoking `onDirty()` — the callback codeIndex
 *      provided. The next `getCodeIndex` call then drains the dirty state by
 *      stat'ing all indexed files and re-parsing those whose mtime moved.
 *
 * Why lazy-on-read instead of eager re-parse on every watcher event: AI bulk
 * edits + auto-formatters can fire dozens of events in a second. Eager parsing
 * would thrash the event loop and waste CPU on data nobody queried. Marking
 * dirty + draining on the next read amortizes work to actual demand.
 *
 * Exported as a named function (instead of a side-effect import) so that
 * webpack / esbuild can't tree-shake away the registration call. Caller in
 * src/lib/wsServer.ts invokes it once at boot.
 */

import { registerWatcherSubscriber } from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';
import { fileWatcher } from './fileWatcher';

let wired = false;

export function wireCodeIndexToFileWatcher(): void {
  // Idempotent — webpack HMR / Next.js dual-bundle topology can call us twice.
  if (wired) return;
  wired = true;

  registerWatcherSubscriber((cwd, onDirty) => {
    fileWatcher.subscribe(cwd, (events) => {
      // The watcher emits 'file' (working-tree change) and 'git' (HEAD/refs
      // move). 'file' implies source content changed. 'git' also implies
      // content may differ (checkout / merge moves files).
      if (events.some((e) => e.type === 'file' || e.type === 'git')) {
        onDirty();
      }
    });
  });
}
