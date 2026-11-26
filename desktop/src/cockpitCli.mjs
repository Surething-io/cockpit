// Everything the desktop app knows about the npm-installed cockpit: where its
// CLI lives, how to run it, and how to tell whether its server is up.
//
// The app never runs the server itself. Starting, stopping, restarting and
// updating all go through the `cockpit` CLI (bin/cock-service.mjs), so a server
// started from the app is exactly the one `cockpit start` would give a terminal
// user, and `cockpit status` / `stop` keep working on it.
//
// Plain module with no Electron imports, so it is unit-testable.
import { spawn } from 'child_process';
import { existsSync, readFileSync } from 'fs';
import { homedir } from 'os';
import { delimiter, join, resolve } from 'path';

export const NPM_PACKAGE = '@surething/cockpit';
// Keep in sync with package.json#engines.node of the npm package.
export const MIN_NODE_VERSION = '22.19.0';
export const DEFAULT_PORT = 3457;

/** Value of PATH, whatever its case (Windows spells it `Path`). */
export function pathOf(env) {
  const key = Object.keys(env).find((k) => k.toUpperCase() === 'PATH');
  return key ? env[key] : '';
}

/** First `names` entry found on `pathValue`, as an absolute path, or null. */
export function whichIn(names, pathValue, { sep = delimiter, exists = existsSync } = {}) {
  for (const dir of (pathValue || '').split(sep)) {
    if (!dir) continue;
    for (const name of names) {
      const candidate = join(dir, name);
      if (exists(candidate)) return candidate;
    }
  }
  return null;
}

/** Locate node, npm and cockpit on the user's PATH. */
export function findTools(env, platform = process.platform, exists = existsSync) {
  const win = platform === 'win32';
  const opts = { sep: win ? ';' : ':', exists };
  const path = pathOf(env);
  return {
    node: whichIn(win ? ['node.exe'] : ['node'], path, opts),
    npm: whichIn(win ? ['npm.cmd'] : ['npm'], path, opts),
    cockpit: whichIn(win ? ['cockpit.cmd'] : ['cockpit'], path, opts),
  };
}

/** Parse `v24.1.0` / `1.2.3` into numbers; null when unparseable. */
export function parseVersion(text) {
  const m = String(text || '').trim().match(/^v?(\d+)\.(\d+)\.(\d+)/);
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
}

/** -1 / 0 / 1 like a comparator; null when either side is unparseable. */
export function compareVersions(a, b) {
  const x = parseVersion(a);
  const y = parseVersion(b);
  if (!x || !y) return null;
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] < y[i] ? -1 : 1;
  }
  return 0;
}

/** Quote one argument for cmd.exe, which is what runs a .cmd shim. */
function quoteForCmd(arg) {
  return /[\s"&|<>^()]/.test(arg) ? `"${arg.replace(/"/g, '""')}"` : arg;
}

/**
 * Run a CLI (cockpit / npm / node) and collect its output.
 *
 * On Windows npm and cockpit are `.cmd` shims, which Node refuses to spawn
 * without a shell (CVE-2024-27980), hence `shell: true` plus manual quoting.
 */
export function runTool(file, args, { env, onLine, timeoutMs = 0, platform = process.platform } = {}) {
  return new Promise((resolvePromise) => {
    const viaShell = platform === 'win32' && /\.cmd$/i.test(file);
    let child;
    try {
      child = viaShell
        ? spawn([file, ...args].map(quoteForCmd).join(' '), { env, shell: true, windowsHide: true })
        : spawn(file, args, { env, windowsHide: true });
    } catch (err) {
      resolvePromise({ code: -1, output: String(err?.message ?? err) });
      return;
    }
    let output = '';
    let pending = '';
    const feed = (chunk) => {
      const text = chunk.toString('utf8');
      output += text;
      if (!onLine) return;
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop();
      for (const line of lines) onLine(line);
    };
    child.stdout?.on('data', feed);
    child.stderr?.on('data', feed);
    const timer = timeoutMs > 0 ? setTimeout(() => child.kill(), timeoutMs) : null;
    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      resolvePromise({ code: -1, output: output + String(err?.message ?? err) });
    });
    child.on('close', (code) => {
      if (timer) clearTimeout(timer);
      if (onLine && pending) onLine(pending);
      resolvePromise({ code: code ?? -1, output });
    });
  });
}

/** Same rule as bin/cockpitHome.mjs: COCKPIT_HOME wins, `~` expands. */
export function cockpitHomeOf(env) {
  return env.COCKPIT_HOME
    ? resolve(env.COCKPIT_HOME.replace(/^~(?=$|[\\/])/, homedir()))
    : join(homedir(), '.cockpit');
}

/** The record a running server writes to <home>/server.json, or null. */
export function readServerRecord(env) {
  try {
    return JSON.parse(readFileSync(join(cockpitHomeOf(env), 'server.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Port to connect to: the live record first, then the CLI's own default. */
export function portOf(env, record = readServerRecord(env)) {
  const fromRecord = Number(record?.port);
  if (Number.isInteger(fromRecord) && fromRecord > 0) return fromRecord;
  const fromEnv = Number(env.PORT || env.COCKPIT_PORT);
  return Number.isInteger(fromEnv) && fromEnv > 0 ? fromEnv : DEFAULT_PORT;
}

/**
 * The /api/health body when a cockpit answers on `port`, else null — the same
 * identity check bin/cock-service.mjs uses, so an unrelated service holding the
 * port reads as "not running".
 */
export async function probeHealth(port, timeoutMs = 1500) {
  try {
    const res = await fetch(`http://127.0.0.1:${port}/api/health`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return null;
    const body = await res.json();
    return body?.app === 'cockpit' ? body : null;
  } catch {
    return null;
  }
}
