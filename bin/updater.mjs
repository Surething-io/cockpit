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
import { appendFileSync, mkdirSync, openSync, readFileSync, writeFileSync } from 'fs';
import { join } from 'path';

const PKG = '@surething/cockpit';
const EXIT_WAIT_MS = 30_000;
const POLL_MS = 250;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const serverPid = Number(arg('pid', '0'));
const installRoot = arg('root');
const cockpitHome = arg('home');
const fromVersion = arg('from', 'unknown');
const target = arg('to', 'latest');

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

function writeState(patch) {
  try {
    writeFileSync(
      statePath,
      JSON.stringify({ from: fromVersion, target, pid: process.pid, ...patch }, null, 2)
    );
  } catch { /* best effort */ }
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

function readInstalledVersion() {
  try {
    return JSON.parse(readFileSync(join(installRoot, 'package.json'), 'utf8')).version;
  } catch {
    return null;
  }
}

function runNpm(args) {
  log(`npm ${args.join(' ')}`);
  const r = spawnSync('npm', args, {
    encoding: 'utf-8',
    // Windows npm is npm.cmd; Node >=18.20/20.12 refuses to spawn .cmd without
    // a shell (CVE-2024-27980).
    shell: process.platform === 'win32',
  });
  if (r.error) {
    log(`npm failed to launch: ${r.error.message}`);
    return { ok: false, reason: `could not run npm: ${r.error.message}` };
  }
  if (r.stdout) log(r.stdout.trim());
  if (r.stderr) log(r.stderr.trim());
  if (r.status !== 0) return { ok: false, reason: `npm exited ${r.status}` };
  return { ok: true };
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

async function main() {
  mkdirSync(join(cockpitHome, 'logs'), { recursive: true });
  const mode = restartOnly ? 'restart' : 'update';
  log(
    restartOnly
      ? `--- restart start (server pid ${serverPid}) ---`
      : `--- update start: ${fromVersion} -> ${target} (server pid ${serverPid}) ---`
  );
  writeState({ mode, phase: 'waiting-for-exit', startedAt: Date.now() });

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
    process.exit(ok ? 0 : 1);
  }

  writeState({ mode, phase: 'installing', startedAt: Date.now() });
  const install = runNpm(['install', '-g', `${PKG}@${target}`, '--include=optional']);

  if (!install.ok) {
    // 3a. Roll back to the version we came from. npm may have already removed
    //     the old tree, so leaving it as-is can mean no cockpit at all.
    log(`install failed (${install.reason}) — rolling back to ${fromVersion}`);
    writeState({ phase: 'rolling-back', error: install.reason });
    const rollback =
      fromVersion !== 'unknown'
        ? runNpm(['install', '-g', `${PKG}@${fromVersion}`, '--include=optional'])
        : { ok: false, reason: 'unknown previous version' };
    const restarted = startServer();
    writeState({
      phase: 'failed',
      error: install.reason,
      rolledBack: rollback.ok,
      restarted,
      finishedAt: Date.now(),
    });
    log(`--- update failed; rollback ${rollback.ok ? 'ok' : 'FAILED'} ---`);
    process.exit(1);
  }

  // 3b. Success.
  const installed = readInstalledVersion();
  log(`installed version now: ${installed}`);
  writeState({ phase: 'restarting', installed });

  const restarted = startServer();
  writeState({
    phase: restarted ? 'done' : 'failed',
    installed,
    restarted,
    // Same version means npm had nothing newer to give — not an error.
    unchanged: installed === fromVersion,
    finishedAt: Date.now(),
  });
  log(`--- update ${restarted ? 'complete' : 'installed but respawn FAILED'} ---`);
  process.exit(restarted ? 0 : 1);
}

main().catch((e) => {
  log(`updater crashed: ${e && e.stack ? e.stack : e}`);
  // Never leave the user without a server because the updater itself broke.
  const restarted = startServer();
  writeState({ phase: 'failed', error: String(e), restarted, finishedAt: Date.now() });
  process.exit(1);
});
