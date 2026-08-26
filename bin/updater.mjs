// Out-of-process updater. Started detached by POST /api/update, runs while the
// server is down, and brings it back up afterwards.
//
// SELF-CONTAINED BY REQUIREMENT — do not add imports of cockpit's own modules.
// This script is copied out to <cockpitHome>/updater/ before being run, because
// `npm i -g` replaces the whole install directory underneath it. A script
// running from that directory, or importing anything inside it, can vanish
// mid-execution. Node builtins only.
//
// Why an external process at all: a process cannot reinstall the package it is
// running from. On Windows that is a hard block (node-pty's pty.node/conpty.node
// are dlopen'd, so the files are locked and the install fails outright); on
// POSIX it "works" only until the server lazily imports a chunk that npm has
// already deleted. So: server exits -> updater installs -> updater respawns it.
//
// The environment is inherited through this whole chain. That is what preserves
// COCKPIT_TOKEN, PORT, COCKPIT_HOST and COCKPIT_HOME across the restart —
// losing the token would silently turn a tunnel-exposed instance into an open
// one, so it must never be re-derived from defaults.
import { spawn, spawnSync } from 'child_process';
import { appendFileSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, writeFileSync } from 'fs';
import { createServer } from 'http';
import { createRequire } from 'module';
import { dirname, join } from 'path';

const PKG = '@surething/cockpit';
const EXIT_WAIT_MS = 30_000;
const POLL_MS = 250;
// Hold the status port briefly after the terminal state is written so a client
// polling at ~1s can still read it. The replacement server binds the MAIN port,
// never this one, so lingering here races nothing.
const TERMINAL_LINGER_MS = 3_000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const serverPid = Number(arg('pid', '0'));
const installRoot = arg('root');
const cockpitHome = arg('home');
const fromVersion = arg('from', 'unknown');
const target = arg('to', 'latest');
// Allocated by /api/update (bind :0, close, hand the number over) and echoed to
// the browser in the same response. Absent => no live channel, and the UI falls
// back to a local timer; nothing here treats that as an error.
const statusPort = Number(arg('status-port', '0')) || 0;

// --restart-only reuses everything here except the install step. A restart has
// the same hard requirement as an update — the replacement must be launched by
// a process that is NOT the one being replaced — and, more importantly, it is
// how the server's environment survives: COCKPIT_TOKEN, PORT and COCKPIT_HOST
// are inherited down this chain. A CLI-driven stop+start instead rebuilds the
// environment from whatever shell the user happens to be in, which silently
// drops the token and leaves the instance open.
const restartOnly = process.argv.includes('--restart-only');

if (!installRoot || !cockpitHome) {
  console.error('updater: --root and --home are required');
  process.exit(2);
}

const logPath = join(cockpitHome, 'logs', 'updater.log');
const statePath = join(cockpitHome, 'update-state.json');

function log(line) {
  const stamped = `[${new Date().toISOString()}] ${line}\n`;
  try {
    appendFileSync(logPath, stamped);
  } catch { /* logging must never abort an update */ }
}

// The previous run's timings, read BEFORE we overwrite the file. `installMs` is
// the only anchor the UI has for "how long will this take" — carry it forward
// even through a failed run, or one bad update erases the baseline for good.
function readPrevState() {
  try {
    return JSON.parse(readFileSync(statePath, 'utf8'));
  } catch {
    return null;
  }
}
const prevState = readPrevState();
const prevInstallMs = Number(prevState?.installMs) || Number(prevState?.prevInstallMs) || null;

// Mirrored in memory so the status server can answer without touching the disk.
let currentState = {};

function writeState(patch) {
  currentState = { from: fromVersion, target, pid: process.pid, prevInstallMs, ...patch };
  try {
    writeFileSync(statePath, JSON.stringify(currentState, null, 2));
  } catch { /* best effort */ }
}

/**
 * Serve the live update state to the browser while the server is down.
 *
 * MUST bind 127.0.0.1 explicitly. Omitting the host makes Node listen on
 * `::`/0.0.0.0, which is the one thing that trips the macOS/Windows firewall
 * prompt — and it would publish update state to the LAN. Loopback-only
 * listeners are not filtered by either OS firewall.
 *
 * Every failure here is silent by design: this is a progress nicety, and an
 * update must never fail because a port could not be bound.
 */
let statusServer = null;

function startStatusServer() {
  if (!statusPort) return;
  try {
    const srv = createServer((req, res) => {
      res.writeHead(200, {
        'content-type': 'application/json',
        // The page is served from localhost:<main port>; this is a different
        // origin. Loopback-bound and read-only, so * is not a widening.
        'access-control-allow-origin': '*',
        'cache-control': 'no-store',
      });
      res.end(JSON.stringify(currentState));
    });
    srv.on('error', (e) => log(`status server unavailable: ${e.message}`));
    srv.listen(statusPort, '127.0.0.1', () => log(`status server on 127.0.0.1:${statusPort}`));
    statusServer = srv;
  } catch (e) {
    log(`status server failed to start: ${e.message}`);
  }
}

/** Linger, release the port, exit. Every exit path goes through here. */
async function finish(code) {
  if (statusServer) {
    await sleep(TERMINAL_LINGER_MS);
    try {
      statusServer.closeAllConnections?.();
      statusServer.close();
    } catch { /* exiting anyway */ }
  }
  process.exit(code);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function pidAlive(pid) {
  if (!pid) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Which bundled agent CLIs are missing their platform-specific native binary.
 *
 * DUPLICATED from scripts/agentBinaries.mjs — change both together. This file
 * cannot import it: it runs from <cockpitHome>/updater/ precisely because
 * `npm i -g` deletes the install directory mid-run (see the header).
 *
 * Resolution is anchored at installRoot rather than import.meta.url. This
 * script lives OUTSIDE the install tree, so resolving from its own location
 * would search <cockpitHome>/updater/node_modules and report "missing" every
 * single time — which, given what the caller does about it, would mean
 * uninstalling and reinstalling cockpit on every update.
 */
function missingAgentBinaries() {
  const missing = [];
  let req;
  try {
    req = createRequire(join(installRoot, 'package.json'));
  } catch {
    // Install tree unreadable — same answer as everything missing.
    return ['Claude', 'Codex'];
  }

  const dirOf = (name) => {
    try {
      return dirname(req.resolve(`${name}/package.json`));
    } catch {
      return null;
    }
  };

  const base = `${process.platform}-${process.arch}`;
  // linux ships glibc and musl variants of the Claude binary under distinct package names.
  const claudeVariants = process.platform === 'linux' ? [base, `${base}-musl`] : [base];
  const hasClaude = claudeVariants.some((variant) => {
    const dir = dirOf(`@anthropic-ai/claude-agent-sdk-${variant}`);
    if (!dir) return false;
    const bin = join(dir, 'claude');
    return existsSync(bin) || existsSync(`${bin}.exe`);
  });
  if (!hasClaude) missing.push('Claude');

  // Codex nests its binary under a Rust target triple; scan vendor/ rather than
  // reproducing codex-sdk's private platform->triple table. No musl split here.
  let hasCodex = false;
  const codexDir = dirOf(`@openai/codex-${base}`);
  if (codexDir) {
    try {
      hasCodex = readdirSync(join(codexDir, 'vendor')).some((target) => {
        const bin = join(codexDir, 'vendor', target, 'bin', 'codex');
        return existsSync(bin) || existsSync(`${bin}.exe`);
      });
    } catch { /* no vendor dir — same answer as missing */ }
  }
  if (!hasCodex) missing.push('Codex');

  return missing;
}

function readInstalledVersion() {
  try {
    return JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

/**
 * Run npm and resolve with the outcome.
 *
 * Deliberately async (was spawnSync): spawnSync blocks this process's event
 * loop for the entire install, which is exactly the window the status server
 * has to answer in. With spawnSync the socket would accept connections into the
 * kernel backlog and reply to none of them.
 *
 * Output is drained as it arrives rather than after exit — an undrained pipe
 * fills its buffer and deadlocks npm.
 */
function runNpm(args) {
  log(`npm ${args.join(' ')}`);
  return new Promise((resolve) => {
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    let child;
    try {
      child = spawn('npm', args, {
        // Windows npm is npm.cmd; Node >=18.20/20.12 refuses to spawn .cmd
        // without a shell (CVE-2024-27980).
        shell: process.platform === 'win32',
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      log(`npm failed to launch: ${e.message}`);
      done({ ok: false, reason: `could not run npm: ${e.message}` });
      return;
    }

    let out = '';
    child.stdout?.setEncoding('utf-8');
    child.stderr?.setEncoding('utf-8');
    child.stdout?.on('data', (d) => { out += d; });
    child.stderr?.on('data', (d) => { out += d; });

    child.on('error', (e) => {
      log(`npm failed to launch: ${e.message}`);
      done({ ok: false, reason: `could not run npm: ${e.message}` });
    });
    child.on('close', (code) => {
      if (out.trim()) log(out.trim());
      done(code === 0 ? { ok: true } : { ok: false, reason: `npm exited ${code}` });
    });
  });
}

/**
 * Restart the server.
 *
 * Always detached, even when the old instance ran in the foreground: the
 * terminal that owned it has already returned to its shell by the time we get
 * here, so there is nothing to hand it back to. The UI states this outright
 * before starting, rather than silently changing how the user stops cockpit.
 */
function startServer() {
  try {
    mkdirSync(join(cockpitHome, 'logs'), { recursive: true });
    const fd = openSync(join(cockpitHome, 'logs', 'server.log'), 'a');
    const child = spawn(process.execPath, ['server.mjs'], {
      cwd: installRoot,
      env: {
        ...process.env,
        // Inherited env carries the original PORT/token/host. Only the
        // supervision mode and the browser-opening behaviour change: the user
        // is already looking at the page that triggered this.
        COCKPIT_MANAGED: 'bare',
        COCKPIT_NO_OPEN: '1',
        COCKPIT_OPEN_PROJECT: '',
      },
      detached: true,
      windowsHide: true,
      stdio: ['ignore', fd, fd],
    });
    child.unref();
    log(`server respawned, pid ${child.pid}`);
    return true;
  } catch (e) {
    log(`failed to respawn server: ${e.message}`);
    return false;
  }
}

/** What the user has to run by hand if we cannot repair it ourselves. */
const MANUAL_FIX = `npm uninstall -g ${PKG} && npm install -g ${PKG}`;

/**
 * Make sure the agents' platform-specific native binaries survived the install.
 *
 * They ship as OPTIONAL dependencies, and npm skips them often enough during an
 * in-place `npm i -g` that cock-service.mjs guards the offline path the same
 * way. Nothing else notices: the install exits 0, the server comes back, and
 * chat dies at the first message with "Native CLI binary not found". This path
 * — the UI button — had no guard at all, so it reported "update complete" and
 * handed back a Cockpit that could not chat.
 *
 * Codex fails more quietly than Claude: rather than throwing, its engine falls
 * back to whatever `codex` is on PATH — an unpinned build the SDK was never
 * paired with. That is why both are checked here, not just Claude.
 *
 * Escalates deliberately. The clean uninstall is the only thing that reliably
 * makes npm refetch a skipped optional dep, but it DELETES a working install,
 * so it runs only after --force has failed. If the reinstall then fails we are
 * left with nothing, which is why the previous version is put back as a last
 * resort — and why the status port matters here: with no server, that card is
 * the only channel left to tell the user what to run.
 */
async function repairAgentBinaries() {
  let missing = missingAgentBinaries();
  if (!missing.length) return { ok: true };

  log(`native ${missing.join(' and ')} binary missing after install — repairing`);
  writeState({ ...currentState, phase: 'repairing' });

  // Non-destructive first: --force re-reifies the tree without removing it.
  await runNpm(['install', '-g', `${PKG}@${target}`, '--include=optional', '--force']);
  if (!missingAgentBinaries().length) {
    log('repaired with --force');
    return { ok: true };
  }

  log('still missing — clean uninstall + reinstall');
  await runNpm(['uninstall', '-g', PKG]);
  const reinstall = await runNpm(['install', '-g', `${PKG}@${target}`, '--include=optional']);
  if (!reinstall.ok) {
    log(`reinstall after uninstall FAILED (${reinstall.reason}) — restoring ${fromVersion}`);
    if (fromVersion !== 'unknown') {
      await runNpm(['install', '-g', `${PKG}@${fromVersion}`, '--include=optional']);
    }
    return { ok: false, reason: `reinstall failed: ${reinstall.reason}` };
  }
  missing = missingAgentBinaries();
  if (!missing.length) {
    log('repaired with uninstall + reinstall');
    return { ok: true };
  }
  return {
    ok: false,
    reason: `the native ${missing.join(' and ')} binary is still missing; ${missing.length > 1 ? 'those engines' : 'that engine'} will not work`,
  };
}

async function main() {
  mkdirSync(join(cockpitHome, 'logs'), { recursive: true });
  const mode = restartOnly ? 'restart' : 'update';
  log(
    restartOnly
      ? `--- restart start (server pid ${serverPid}) ---`
      : `--- update start: ${fromVersion} -> ${target} (server pid ${serverPid}) ---`
  );
  writeState({ mode, phase: 'waiting-for-exit', startedAt: Date.now() });
  // Up before the wait loop: the old server is still holding the main port for
  // ~300ms, so the browser can hand over to this channel without a visible gap.
  startStatusServer();

  // 1. Wait for the server to release the install directory.
  const deadline = Date.now() + EXIT_WAIT_MS;
  while (pidAlive(serverPid) && Date.now() < deadline) await sleep(POLL_MS);
  if (pidAlive(serverPid)) {
    log(`server ${serverPid} still alive after ${EXIT_WAIT_MS}ms — forcing`);
    try {
      if (process.platform === 'win32') {
        spawnSync('taskkill', ['/PID', String(serverPid), '/T', '/F'], { stdio: 'ignore' });
      } else {
        process.kill(serverPid, 'SIGKILL');
      }
    } catch { /* already gone */ }
    await sleep(1000);
  }
  // Windows needs a beat after exit for the loader to drop its handles on the
  // native .node files; installing too early fails with EPERM/EBUSY.
  if (process.platform === 'win32') await sleep(2000);

  // 2. Bring it back. A restart stops here — no install, no rollback path.
  if (restartOnly) {
    writeState({ mode, phase: 'restarting' });
    const ok = startServer();
    writeState({ mode, phase: ok ? 'done' : 'failed', restarted: ok, finishedAt: Date.now() });
    log(`--- restart ${ok ? 'complete' : 'FAILED'} ---`);
    await finish(ok ? 0 : 1);
    return;
  }

  const installStartedAt = Date.now();
  writeState({ mode, phase: 'installing', startedAt: installStartedAt });
  const install = await runNpm(['install', '-g', `${PKG}@${target}`, '--include=optional']);
  // Measured on the success path only — a failed install stops early and would
  // poison the baseline with a number the next run cannot be compared against.
  const installMs = install.ok ? Date.now() - installStartedAt : null;

  if (!install.ok) {
    // 3a. Roll back to the version we came from. npm may have already removed
    //     the old tree, so leaving it as-is can mean no cockpit at all.
    log(`install failed (${install.reason}) — rolling back to ${fromVersion}`);
    // Published before the rollback npm run, not after: rolling back is a
    // second full install, so without this the UI would sit on "installing" for
    // twice the expected time with no idea anything had gone wrong.
    writeState({ mode, phase: 'rolling-back', startedAt: installStartedAt, error: install.reason });
    const rollback =
      fromVersion !== 'unknown'
        ? await runNpm(['install', '-g', `${PKG}@${fromVersion}`, '--include=optional'])
        : { ok: false, reason: 'unknown previous version' };
    const restarted = startServer();
    writeState({
      mode,
      phase: 'failed',
      startedAt: installStartedAt,
      error: install.reason,
      rolledBack: rollback.ok,
      restarted,
      finishedAt: Date.now(),
    });
    log(`--- update failed; rollback ${rollback.ok ? 'ok' : 'FAILED'} ---`);
    await finish(1);
    return;
  }

  // 3b. Installed — but not necessarily complete. See repairAgentBinaries.
  const repair = await repairAgentBinaries();

  const installed = readInstalledVersion();
  log(`installed version now: ${installed} (install took ${installMs}ms)`);
  writeState({ mode, phase: 'restarting', startedAt: installStartedAt, installed, installMs });

  const restarted = startServer();
  const succeeded = restarted && repair.ok;
  writeState({
    mode,
    phase: succeeded ? 'done' : 'failed',
    startedAt: installStartedAt,
    installed,
    installMs,
    restarted,
    claudeBinary: repair.ok,
    // Same version means npm had nothing newer to give — not an error.
    unchanged: installed === fromVersion,
    ...(succeeded
      ? {}
      : {
          error: repair.ok ? 'the server did not come back up' : repair.reason,
          fixCommand: repair.ok ? undefined : MANUAL_FIX,
        }),
    finishedAt: Date.now(),
  });
  log(`--- update ${succeeded ? 'complete' : 'FAILED'} ---`);
  await finish(succeeded ? 0 : 1);
}

main().catch(async (e) => {
  log(`updater crashed: ${e && e.stack ? e.stack : e}`);
  // Never leave the user without a server because the updater itself broke.
  const restarted = startServer();
  writeState({ phase: 'failed', error: String(e), restarted, finishedAt: Date.now() });
  await finish(1);
});
