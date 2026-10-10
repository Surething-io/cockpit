// Exclusive per-data-dir instance lock: <home>/server.lock, holding the owner's pid.
//
// The health probe in server.mjs only sees an instance that is already listening, so
// two processes started together (a service autostart plus a manual `cockpit`) could
// both find nothing and both boot on one data dir — two schedulers firing every task.
// Creating the lock exclusively (see createExclusive) decides that race: exactly one
// create succeeds.
//
// A lock left by a dead process (crash, SIGKILL, reboot) is taken over. "Dead" means its
// pid no longer exists, or it was written in an earlier boot (pids are reused after a
// reboot). The lock file is never deleted during a takeover — that would open a moment
// where a plain create could also win. Instead the contenders race for a claim on that
// particular stale record (another exclusive create, named after the record), and the one
// claimant renames its own record over the stale one in a single atomic step.
import { linkSync, mkdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'fs';
import { createHash, randomUUID } from 'crypto';
import { uptime } from 'os';
import { join } from 'path';

const BOOT_SLACK_S = 120;
const bootTime = () => Math.round(Date.now() / 1000 - uptime());

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === 'EPERM'; }
}

function parse(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function readText(path) {
  try { return readFileSync(path, 'utf8'); } catch (e) { if (e.code === 'ENOENT') return null; throw e; }
}

function isStale(rec) {
  if (!rec || !Number.isInteger(rec.pid)) return true; // not a lock record we can read
  if (typeof rec.boot === 'number' && Math.abs(rec.boot - bootTime()) > BOOT_SLACK_S) return true;
  return !pidAlive(rec.pid);
}

/**
 * Create `path` holding `body`, failing if it exists. The content is written to a temp
 * file first and published with link() — which, like O_EXCL, refuses an existing target —
 * so the file never appears empty. (An O_EXCL create is visible before its write lands,
 * and a contender reading it then would judge it a crashed, stale lock.)
 */
function createExclusive(path, body) {
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, body, { mode: 0o600 });
  try {
    linkSync(tmp, path);
    return true;
  } catch (e) {
    if (e.code === 'EEXIST') return false;
    throw e;
  } finally {
    try { unlinkSync(tmp); } catch { /* gone */ }
  }
}

/**
 * Try to take the lock for `home`. Returns `{ ok: true, release }`, or
 * `{ ok: false, pid }` with the pid of the live instance that holds (or is taking) it.
 */
export function acquireInstanceLock(home) {
  mkdirSync(home, { recursive: true });
  const path = join(home, 'server.lock');
  const body = JSON.stringify({ pid: process.pid, boot: bootTime(), id: randomUUID() });
  const won = () => ({
    ok: true,
    release: () => {
      try { if (readText(path) === body) unlinkSync(path); } catch { /* gone */ }
    },
  });

  for (let attempt = 0; attempt < 5; attempt++) {
    if (createExclusive(path, body)) return won();

    const seen = readText(path);
    if (seen === null) continue; // released in between — try the create again
    const rec = parse(seen);
    if (!isStale(rec)) return { ok: false, pid: rec.pid };

    // Claim this stale record. Only one contender can create the claim.
    const claim = `${path}.claim-${createHash('sha256').update(seen).digest('hex').slice(0, 16)}`;
    if (!createExclusive(claim, String(process.pid))) {
      const claimant = Number(readText(claim));
      if (Number.isInteger(claimant) && claimant > 0 && pidAlive(claimant)) return { ok: false, pid: claimant };
      try { unlinkSync(claim); } catch { /* another contender cleared it */ }
      continue; // the claimant died mid-takeover
    }
    try {
      // Still the record we judged stale? Only the claimant can replace it, so a match
      // here holds until our rename below.
      if (readText(path) !== seen) continue;
      const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
      writeFileSync(tmp, body, { mode: 0o600 });
      renameSync(tmp, path);
      return won();
    } finally {
      try { unlinkSync(claim); } catch { /* gone */ }
    }
  }
  const holder = parse(readText(path) ?? '');
  return { ok: false, pid: holder?.pid ?? 0 };
}
