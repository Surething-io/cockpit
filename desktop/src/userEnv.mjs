// Resolve the environment the user's own terminal would have.
//
// A GUI app does not get it for free. On macOS an app started from Finder or
// the Dock inherits launchd's minimal environment — PATH is roughly
// /usr/bin:/bin:/usr/sbin:/sbin — so node, npm, cockpit, git and every agent
// CLI are invisible. On Windows the app inherits Explorer's environment, which
// is frozen at login: a Node.js installed after that is not on our PATH.
//
// This matters beyond finding `cockpit`: `cockpit start` hands our environment
// to the server it launches, and the server hands it to every agent and
// terminal. Whatever we get wrong here, the whole session inherits.
//
// Plain module with no Electron imports, so the parsers are unit-testable.
import { execFile } from 'child_process';

const SHELL_TIMEOUT_MS = 10_000;
const MARKER = '__COCKPIT_ENV_9f2c__';

// Variables that describe the shell process we spawned rather than the user's
// environment. Copying them would only confuse the processes we launch.
const SHELL_ONLY = new Set(['_', 'SHLVL', 'PWD', 'OLDPWD', 'COCKPIT_DESKTOP_ENV_PROBE']);

/**
 * Extract the variables printed between two markers by `env -0`.
 *
 * Markers are needed because an interactive login shell runs the user's rc
 * files, which may print banners, `nvm` notices or fortune cookies to stdout.
 */
export function parseEnvDump(stdout, marker = MARKER) {
  const start = stdout.indexOf(marker);
  const end = stdout.lastIndexOf(marker);
  if (start === -1 || end <= start) return null;
  const body = stdout.slice(start + marker.length, end);
  const env = {};
  for (const entry of body.split('\0')) {
    const clean = entry.replace(/^\n/, '');
    const eq = clean.indexOf('=');
    if (eq <= 0) continue;
    const key = clean.slice(0, eq);
    if (SHELL_ONLY.has(key)) continue;
    env[key] = clean.slice(eq + 1);
  }
  return Object.keys(env).length > 0 ? env : null;
}

/** Ask the user's login shell (`$SHELL -ilc`) for its environment. */
function loginShellEnv(baseEnv) {
  const shell = baseEnv.SHELL || '/bin/zsh';
  const command = `printf '%s' '${MARKER}'; env -0; printf '%s' '${MARKER}'`;
  return new Promise((resolve) => {
    execFile(
      shell,
      ['-ilc', command],
      {
        env: { ...baseEnv, COCKPIT_DESKTOP_ENV_PROBE: '1' },
        timeout: SHELL_TIMEOUT_MS,
        maxBuffer: 8 * 1024 * 1024,
        encoding: 'utf8',
      },
      // A non-zero exit from a noisy rc file still printed the env we need.
      (_err, stdout) => resolve(parseEnvDump(stdout || '')),
    );
  });
}

/**
 * Parse the output of `reg query <key> /v <name>`.
 * Returns `{ type, value }` or null when the value is absent.
 */
export function parseRegQuery(stdout, name) {
  for (const line of stdout.split(/\r?\n/)) {
    const m = line.match(/^\s+(\S+)\s+(REG_SZ|REG_EXPAND_SZ)\s+(.*)$/);
    if (m && m[1].toLowerCase() === name.toLowerCase()) return { type: m[2], value: m[3].trim() };
  }
  return null;
}

/** Expand `%VAR%` references the way Windows does for REG_EXPAND_SZ values. */
export function expandWindowsVars(value, env) {
  const lookup = new Map(Object.entries(env).map(([k, v]) => [k.toLowerCase(), v]));
  return value.replace(/%([^%]+)%/g, (whole, name) => lookup.get(name.toLowerCase()) ?? whole);
}

/**
 * Join machine PATH then user PATH (the order Windows itself uses), dropping
 * empty and duplicate entries case-insensitively.
 */
export function mergeWindowsPath(...parts) {
  const seen = new Set();
  const out = [];
  for (const part of parts) {
    for (const dir of (part || '').split(';')) {
      const d = dir.trim();
      if (!d || seen.has(d.toLowerCase())) continue;
      seen.add(d.toLowerCase());
      out.push(d);
    }
  }
  return out.join(';');
}

function regQuery(key, name) {
  return new Promise((resolve) => {
    execFile('reg', ['query', key, '/v', name], { windowsHide: true, timeout: 5000, encoding: 'utf8' }, (err, stdout) =>
      resolve(err ? null : parseRegQuery(stdout || '', name)),
    );
  });
}

/** Re-read PATH from the registry, so installs made after login are visible. */
async function windowsEnv(baseEnv) {
  const [machine, user] = await Promise.all([
    regQuery('HKLM\\SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment', 'Path'),
    regQuery('HKCU\\Environment', 'Path'),
  ]);
  if (!machine && !user) return null;
  const expand = (v) => (v ? expandWindowsVars(v.value, baseEnv) : '');
  // Keep whatever we inherited too: a portable shell may have added entries.
  const pathKey = Object.keys(baseEnv).find((k) => k.toLowerCase() === 'path') || 'Path';
  const env = { ...baseEnv };
  env[pathKey] = mergeWindowsPath(expand(machine), expand(user), baseEnv[pathKey]);
  return env;
}

/**
 * The environment to run cockpit with. Falls back to our own environment when
 * the probe fails, and says so through `source` so the UI can warn.
 */
export async function resolveUserEnv(baseEnv = process.env, platform = process.platform) {
  // Keep Electron's own switches out of everything we launch.
  const base = { ...baseEnv };
  delete base.ELECTRON_RUN_AS_NODE;
  delete base.ELECTRON_NO_ATTACH_CONSOLE;

  if (platform === 'win32') {
    const env = await windowsEnv(base);
    return env ? { env, source: 'registry' } : { env: base, source: 'inherited' };
  }
  const env = await loginShellEnv(base);
  return env ? { env: { ...env }, source: 'login-shell' } : { env: base, source: 'inherited' };
}
