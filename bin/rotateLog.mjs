// Size-based log rotation, performed at startup only.
//
// Startup rather than on every write, because:
//   - it costs nothing at runtime (one stat per boot);
//   - `cockpit start` hands the server an already-open fd for its stdout, and
//     rotating a file out from under a held fd is a no-op on POSIX (the writer
//     keeps the old inode) and fails outright on Windows. Doing it before the
//     open sidesteps both.
//
// The trade-off: an instance that runs for months without a restart can exceed
// the cap. Acceptable here — Cockpit ships patches every ~1.5 days, so restarts
// are frequent, and the real fix for volume is not logging noise in the first
// place (see the git.status note in feature/explorer/.../effect/git.ts).
//
// One generation is kept (`<name>.1`), so the on-disk ceiling per log is
// 2x maxBytes. Cockpit rotates two logs (cockpit.log, server.log), i.e. at most
// four files.
//
// Cross-platform notes — rename/unlink are where the platforms differ:
//
//   POSIX   renameSync and unlinkSync succeed even while another process holds
//           the file open; the old inode simply stays alive for that writer.
//   Windows both fail with EPERM/EBUSY if any process has the file open
//           without FILE_SHARE_DELETE. So on Windows rotation only works when
//           nothing holds the file, which is why each caller rotates at a point
//           where that is guaranteed:
//             - server.log is rotated before openSync() hands its fd to the
//               spawned server, and `cockpit start` bails out earlier if an
//               instance is already running;
//             - cockpit.log is written with per-line appendFile (no retained
//               fd) and is rotated right after the single-instance check.
//
// A failure here is never fatal: an external holder (a tail -f, an editor with
// the file open) just means the rotation is skipped and retried next boot.
import { statSync, renameSync, unlinkSync, existsSync } from 'fs';

export const DEFAULT_MAX_LOG_BYTES = 10 * 1024 * 1024; // 10 MB

export function rotateIfLarge(path, maxBytes = DEFAULT_MAX_LOG_BYTES) {
  try {
    if (!existsSync(path)) return false;
    if (statSync(path).size < maxBytes) return false;
    const previous = `${path}.1`;
    if (existsSync(previous)) unlinkSync(previous);
    renameSync(path, previous);
    return true;
  } catch {
    // Best effort: a log that cannot be rotated must never stop the server from
    // starting.
    return false;
  }
}
