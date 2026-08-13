// cockpit start | stop | restart | status
//
// Background ("bare") process management, with no supervisor involved: the
// server is spawned detached, its pid/port live in server.json, and stopping
// goes through POST /api/shutdown so the process leaves via its own exit hook
// (which flushes PTY scrollback). Signals are only the fallback — see the note
// on stopProcess() for why they cannot be the primary mechanism.
//
// Deliberately no daemon-manager integration yet: launchd/systemd/service
// registration is a separate step, and this layer has to work on its own for
// the environments those do not cover (WSL1, containers, Linux without
// systemd).
import { spawnSync, spawn } from 'child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath } from 'url';
import { SERVER_JSON_PATH, LOG_DIR, SERVER_LOG_PATH, COCKPIT_HOME_DIR } from './cockpitHome.mjs';
import { rotateIfLarge } from './rotateLog.mjs';
import { hasClaudeBinary } from '../scripts/claudeBinary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

const isWindows = process.platform === 'win32';
const START_TIMEOUT_MS = 30_000;
const STOP_TIMEOUT_MS = 10_000;
const POLL_INTERVAL_MS = 250;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─────────────────────────────────────────────────────────
// State
// ─────────────────────────────────────────────────────────

function readRecord() {
  try {
    return JSON.parse(readFileSync(SERVER_JSON_PATH, 'utf8'));
  } catch {
    return null;
  }
}

function defaultPort() {
  return Number(process.env.PORT || process.env.COCKPIT_PORT || 3457);
}

/**
 * Ask the instance on `port` to identify itself.
 *
 * Returns the /api/health body only when it is a cockpit serving THIS data dir.
 * Anything else — connection refused, a timeout, or some unrelated service that
 * happens to hold the port — reads as "not running", matching the
 * single-instance guard in server.mjs.
 */
async function probe(port, timeoutMs = 1000) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const body = await res.json();
    if (body?.app !== 'cockpit') return null;
    return body;
  } catch {
    return null;
  }
}

/** The live instance for this data dir, or null. */
async function findRunning() {
  const rec = readRecord();
  const port = rec?.port || defaultPort();
  const health = await probe(port);
  if (!health) return null;
  // The probe wins on liveness facts, but must not blank out fields it may
  // legitimately report as null (an older server predating COCKPIT_VERSION);
  // server.json is the fallback for those.
  return {
    ...rec,
    ...health,
    port,
    version: health.version || rec?.version || null,
    buildId: health.buildId || rec?.buildId || null,
  };
}

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

// ─────────────────────────────────────────────────────────
// start
// ─────────────────────────────────────────────────────────

/**
 * Start in the background.
 *
 * Takes no project path. A backgrounded server never opens a browser, so there
 * is no "open this project" action for a path to attach to — it would only
 * decorate a printed URL, while implying the server is bound to one project
 * (it is not; cockpit serves them all). Use `cockpit <path>` for the
 * foreground/open-a-project flow, or pick the project in the UI.
 */
export async function start({ quiet = false } = {}) {
  const existing = await findRunning();
  if (existing) {
    console.log(`Cockpit is already running → http://localhost:${existing.port}`);
    // Name the data dir. "Already running" is confusing when the user believed
    // they were starting an isolated instance — a mistyped COCKPIT_HOME silently
    // falls back to ~/.cockpit and lands on the everyday server instead.
    console.log(`  data dir: ${COCKPIT_HOME_DIR}`);
    return 0;
  }

  if (!existsSync(resolve(PROJECT_ROOT, '.next-prod', 'BUILD_ID'))) {
    console.error('No production build found.\n');
    console.error('Run: npm run build');
    return 1;
  }

  mkdirSync(LOG_DIR, { recursive: true });
  // Rotate before opening: once the fd is held, renaming the file underneath it
  // would silently keep writing to the old inode.
  rotateIfLarge(SERVER_LOG_PATH);
  // Append, never truncate: a previous run's tail is often the only record of
  // why it died.
  const logFd = openSync(SERVER_LOG_PATH, 'a');

  // COCKPIT_OPEN_PROJECT is deliberately NOT set: server.mjs only reads it to
  // build the URL it auto-opens, and that is suppressed below.
  const env = { ...process.env, COCKPIT_MANAGED: 'bare' };
  // The detached server has no terminal to open a browser from meaningfully,
  // and doing so on every `cockpit start` would be surprising.
  env.COCKPIT_NO_OPEN = '1';

  const child = spawn(process.execPath, ['server.mjs'], {
    cwd: PROJECT_ROOT,
    env,
    // POSIX: new session, so closing the terminal does not take the server
    // with it. Windows: a new process group; windowsHide stops a console
    // window from flashing up.
    detached: true,
    windowsHide: true,
    // stdio must go to a file, not 'ignore' — otherwise every log line and
    // crash message is discarded.
    stdio: ['ignore', logFd, logFd],
  });
  child.unref();

  const port = defaultPort();
  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const health = await probe(port);
    if (health) {
      if (!quiet) {
        console.log(`Cockpit started → http://localhost:${health.port || port}`);
        console.log(`  pid ${health.pid}   logs: ${SERVER_LOG_PATH}`);
      }
      return 0;
    }
    // Spawned but already gone → it failed at boot; the reason is in the log.
    if (child.exitCode !== null) break;
  }

  console.error(`Cockpit did not come up within ${START_TIMEOUT_MS / 1000}s.`);
  console.error(`Check the log: ${SERVER_LOG_PATH}`);
  return 1;
}

// ─────────────────────────────────────────────────────────
// stop
// ─────────────────────────────────────────────────────────

/**
 * Escalating stop. HTTP first, signals only as a fallback.
 *
 * Windows has no SIGTERM: process.kill(pid) there maps to TerminateProcess,
 * which kills without running the exit hook, losing unflushed PTY scrollback.
 * POST /api/shutdown behaves identically on every platform and lets the server
 * exit through its normal path, so it is the primary mechanism and the signal
 * path only covers a process too wedged to answer HTTP.
 */
async function stopProcess(rec) {
  const { port, pid } = rec;

  try {
    await fetch(`http://127.0.0.1:${port}/api/shutdown`, {
      method: 'POST',
      signal: AbortSignal.timeout(3000),
    });
  } catch {
    // Unreachable or already going down — fall through to the wait, which
    // decides whether anything still needs killing.
  }

  const deadline = Date.now() + STOP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    if (!(await probe(port, 500)) && !pidAlive(pid)) return true;
  }

  if (!pid) return false;

  console.error('Graceful shutdown timed out — forcing.');
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(pid), '/T', '/F'], { stdio: 'ignore' });
  } else {
    try { process.kill(pid, 'SIGTERM'); } catch { /* already gone */ }
    await sleep(2000);
    if (pidAlive(pid)) {
      try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
    }
  }
  await sleep(POLL_INTERVAL_MS);
  return !pidAlive(pid);
}

export async function stop() {
  const running = await findRunning();
  if (!running) {
    const rec = readRecord();
    // A record with a live pid but no HTTP answer means a wedged process, not
    // a clean "not running" — say so instead of silently doing nothing.
    if (rec && pidAlive(rec.pid)) {
      console.log(`Cockpit (pid ${rec.pid}) is not answering HTTP — forcing.`);
      const ok = await stopProcess(rec);
      console.log(ok ? 'Cockpit stopped.' : 'Failed to stop cockpit.');
      return ok ? 0 : 1;
    }
    console.log('Cockpit is not running.');
    return 0;
  }

  const ok = await stopProcess(running);
  console.log(ok ? 'Cockpit stopped.' : 'Failed to stop cockpit.');
  return ok ? 0 : 1;
}

// ─────────────────────────────────────────────────────────
// status
// ─────────────────────────────────────────────────────────

function formatUptime(startedAt) {
  if (!startedAt) return null;
  let s = Math.floor((Date.now() - startedAt) / 1000);
  if (s < 0) return null;
  const d = Math.floor(s / 86400); s %= 86400;
  const h = Math.floor(s / 3600); s %= 3600;
  const m = Math.floor(s / 60); s %= 60;
  if (d) return `${d}d ${h}h ${m}m`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}

export async function status() {
  const running = await findRunning();
  if (!running) {
    const rec = readRecord();
    if (rec && pidAlive(rec.pid)) {
      console.log('Cockpit: process alive but not answering HTTP');
      console.log(`  pid       ${rec.pid}`);
      console.log(`  port      ${rec.port}`);
      console.log(`  logs      ${SERVER_LOG_PATH}`);
      return 1;
    }
    console.log('Cockpit is not running.');
    console.log(`  data dir  ${COCKPIT_HOME_DIR}`);
    return 1;
  }

  const uptime = formatUptime(running.startedAt);
  console.log('Cockpit is running.');
  console.log(`  version   ${running.version || 'unknown'}`);
  console.log(`  pid       ${running.pid}`);
  console.log(`  port      ${running.port}`);
  if (uptime) console.log(`  uptime    ${uptime}`);
  console.log(`  managed   ${running.managed || 'foreground'}`);
  console.log(`  data dir  ${running.home || COCKPIT_HOME_DIR}`);
  console.log(`  logs      ${SERVER_LOG_PATH}`);
  console.log(`  url       http://localhost:${running.port}`);
  return 0;
}

// ─────────────────────────────────────────────────────────
// restart
// ─────────────────────────────────────────────────────────

/**
 * Is the running instance enforcing a token gate?
 *
 * Probed, not read from disk: the token is deliberately never persisted (it
 * would only widen the blast radius), so asking the server is the only way to
 * find out. A request carrying a forwarding header cannot qualify as "local",
 * so it gets 401 exactly when COCKPIT_TOKEN is set. 203.0.113.x is TEST-NET-3
 * and never routable.
 */
async function hasTokenGate(port) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, {
      headers: { 'X-Forwarded-For': '203.0.113.1' },
      signal: AbortSignal.timeout(2000),
    });
    return res.status === 401;
  } catch {
    return false;
  }
}

/**
 * Restart in place.
 *
 * Takes no project argument on purpose: restarting means "bring back what was
 * running", and the started URL is not shown to anyone here anyway — the user
 * is typically already looking at an open tab.
 */
// ─────────────────────────────────────────────────────────
// update
// ─────────────────────────────────────────────────────────

const PKG = '@surething/cockpit';
/** Install + rollback + respawn; generous because npm is the slow part. */
const UPDATE_TIMEOUT_MS = 5 * 60_000;

function runNpm(args) {
  const r = spawnSync('npm', args, {
    stdio: 'inherit',
    // On Windows npm is npm.cmd, a batch file. Node 18.20+/20.12+ refuses to
    // spawn .cmd without a shell (CVE-2024-27980) — without this the call fails
    // to launch rather than merely returning a non-zero status.
    shell: process.platform === 'win32',
  });
  if (r.error) {
    console.error(`\n✗ Could not run npm: ${r.error.message}`);
    console.error('  Cockpit updates itself through the global npm install, so npm must be on PATH.');
    return 1;
  }
  // spawnSync reports a failure to *launch* through `error` with a null status;
  // checking only `status` would turn that into a silent exit(1).
  return r.status ?? 1;
}

/**
 * Install directly with npm. Only valid when no server is running: replacing
 * the install directory under a live process breaks it — on POSIX the moment
 * Next lazily imports a chunk npm has deleted, and on Windows immediately,
 * because node-pty's dlopen'd .node files are locked.
 */
async function updateOffline() {
  console.log(`Updating ${PKG}...`);
  const installArgs = ['install', '-g', `${PKG}@latest`, '--include=optional'];
  let status = runNpm(installArgs);

  // An in-place `npm i -g` can drop the SDK's platform-specific native binary
  // (an optional dependency) when the SDK version bumps — see
  // scripts/claudeBinary.mjs. A clean uninstall + reinstall reliably refetches
  // it, so chat is never left silently broken.
  if (status === 0 && !hasClaudeBinary()) {
    console.log('Native Claude binary missing after update — reinstalling to repair...');
    runNpm(['uninstall', '-g', PKG]);
    status = runNpm(installArgs);
  }

  if (status === 0) {
    let version = 'unknown';
    try {
      version = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8')).version;
    } catch { /* report what we can */ }
    console.log(`\nUpdated to v${version}`);
    if (!hasClaudeBinary()) {
      console.error('\nWarning: the native Claude CLI binary is still missing; chat will not work.');
      console.error(`Fix manually: npm uninstall -g ${PKG} && npm install -g ${PKG}`);
    }
  }
  return status;
}

/**
 * Update, picking the right mechanism for the current state.
 *
 *   running  -> ask the server to update itself. It hands off to a detached
 *               helper that installs while nothing holds the install directory,
 *               then relaunches with the server's own environment (token, port,
 *               host) intact. Same path the UI button uses.
 *   stopped  -> install directly; nothing to preserve, nothing to coordinate.
 *
 * The old behaviour — always npm, regardless — corrupted a live install and
 * still left the user running the previous code with no hint that a restart
 * was needed.
 */
export async function update() {
  const running = await findRunning();
  if (!running) return updateOffline();

  console.log(`Cockpit is running (pid ${running.pid}) — updating in place.`);
  let res;
  try {
    res = await fetch(`http://127.0.0.1:${running.port}/api/update`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000),
    });
  } catch {
    console.error('\n✗ The running server did not accept the update request.');
    console.error('  Stop it first (`cockpit stop`), then run `cockpit update` again.');
    return 1;
  }

  if (!res.ok) {
    // Refusals are deliberate — dev mode, or a non-local caller. Never fall
    // back to npm here: in dev that would install the published package over
    // the user's source tree.
    const body = await res.json().catch(() => ({}));
    console.error(`\n✗ Update refused: ${body.error ?? `HTTP ${res.status}`}`);
    return 1;
  }

  console.log('Installing and restarting...');
  const replacement = await waitForReplacement(running.port, running.pid, UPDATE_TIMEOUT_MS);
  if (!replacement) {
    console.error('\n✗ The update was accepted but the server has not come back.');
    console.error(`  Log:   ${join(LOG_DIR, 'updater.log')}`);
    console.error(`  State: ${join(COCKPIT_HOME_DIR, 'update-state.json')}`);
    return 1;
  }
  console.log(`\nUpdated to v${replacement.version ?? 'unknown'} (pid ${replacement.pid})`);
  return 0;
}

/** Wait for a pid other than `oldPid` to be serving, i.e. the replacement is up. */
async function waitForReplacement(port, oldPid, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(POLL_INTERVAL_MS);
    const health = await probe(port, 1000);
    if (health && health.pid !== oldPid) return health;
  }
  return null;
}

export async function restart({ force = false } = {}) {
  const running = await findRunning();

  if (running) {
    // Preferred path: ask the SERVER to restart itself. It hands off to a
    // detached helper that inherits its environment, so COCKPIT_TOKEN, PORT and
    // COCKPIT_HOST carry over untouched. Doing it from here instead would
    // rebuild the environment out of the current shell — dropping a token gate
    // without saying so, and forcing the user to re-supply every flag.
    try {
      const res = await fetch(`http://127.0.0.1:${running.port}/api/restart`, {
        method: 'POST',
        signal: AbortSignal.timeout(5000),
      });
      if (res.ok) {
        const replacement = await waitForReplacement(running.port, running.pid);
        if (replacement) {
          console.log(`Cockpit restarted → http://localhost:${replacement.port || running.port}`);
          console.log(`  pid ${replacement.pid}   logs: ${SERVER_LOG_PATH}`);
          return 0;
        }
        console.error('Restart was accepted but the server did not come back.');
        console.error(`Check the log: ${join(LOG_DIR, 'updater.log')}`);
        return 1;
      }
      // Non-OK means the server refused (dev mode, for instance). Fall through
      // to the local path, which reports its own reasons.
    } catch {
      // Unreachable or wedged — fall through and do it the blunt way.
    }
  }

  if (running) {
    // FALLBACK PATH ONLY — reached when the server could not restart itself
    // (wedged, or it refused). Here the environment comes from this shell
    // rather than from the running server, so a token gate would be dropped
    // silently and nothing afterwards would look wrong. Refuse instead.
    if (!force && !process.env.COCKPIT_TOKEN && (await hasTokenGate(running.port))) {
      console.error('\n✗ The running instance requires an access token, but COCKPIT_TOKEN is not set here.');
      console.error('  Restarting now would bring cockpit back with authentication disabled.\n');
      console.error('  Restart with the token:   COCKPIT_TOKEN=<token> cockpit restart');
      console.error('  Or accept the change:     cockpit restart --force\n');
      return 1;
    }
    const ok = await stopProcess(running);
    if (!ok) {
      console.error('Could not stop the running instance; not restarting.');
      return 1;
    }
  }
  return start();
}
