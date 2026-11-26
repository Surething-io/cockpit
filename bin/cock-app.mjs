// cockpit app install | update | uninstall
//
// Installs the OpenCockpit desktop app (desktop/) that matches THIS npm package's
// version. The app is a dedicated browser window onto the server this package
// runs; it does not contain a server of its own.
//
// Why the CLI installs it, rather than the user downloading a .dmg / .zip:
// builds are not code-signed. macOS Gatekeeper and Windows SmartScreen only
// inspect files carrying a "downloaded from the internet" mark (the
// com.apple.quarantine xattr / the Zone.Identifier stream), which browsers
// attach and a plain Node fetch-and-write does not. Installing from here
// therefore opens without the "unidentified developer" dialog.
//
// That also means Gatekeeper is not vouching for the bytes — this file is.
// Every archive is checked against the SHA-256 recorded in
// desktop-checksums.json, which the publish workflow writes into the npm
// package (published with provenance) from the very build it uploads to the
// GitHub Release. No checksum, no install.
import { execFile, spawn } from 'child_process';
import { createHash } from 'crypto';
import { createWriteStream, existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs';
import { homedir } from 'os';
import { basename, dirname, join, relative, resolve } from 'path';
import { Readable } from 'stream';
import { pipeline } from 'stream/promises';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

export const PRODUCT_NAME = 'OpenCockpit';
export const RELEASE_BASE = 'https://github.com/Surething-io/cockpit/releases/download';
const WAIT_PID_TIMEOUT_MS = 30_000;

const USAGE = `Usage: cockpit app <command> [options]

Commands:
  install                 Install the desktop app matching this cockpit version
  update                  Replace an installed desktop app with this version
  uninstall               Remove the desktop app (your data in ~/.cockpit stays)

Options:
  --target <path>         Where the app lives (default: ${process.platform === 'win32' ? '%LOCALAPPDATA%\\Programs\\OpenCockpit' : '~/Applications/OpenCockpit.app'})
  --wait-pid <pid>        Wait for this process to exit first (used by the app itself)
  --relaunch              Open the app when done
  --stage                 update: download and unpack next to the app, don't swap
  --apply                 update: swap in what --stage prepared
  --from <zip|dir>        Install a local build instead of downloading
                          (e.g. desktop/dist after \`npm run desktop:build\`)`;

// ─────────────────────────────────────────────────────────
// Pure helpers (unit-tested)
// ─────────────────────────────────────────────────────────

/** Parse `[command] [--target p] [--wait-pid n] [--relaunch]`. */
export function parseArgs(argv) {
  const out = { command: null, target: null, waitPid: null, relaunch: false, from: null, stage: false, apply: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--target') out.target = argv[++i] ?? null;
    else if (a === '--wait-pid') out.waitPid = Number(argv[++i]) || null;
    else if (a === '--relaunch') out.relaunch = true;
    else if (a === '--from') out.from = argv[++i] ?? null;
    else if (a === '--stage') out.stage = true;
    else if (a === '--apply') out.apply = true;
    else if (a === '-h' || a === '--help' || a === 'help') out.help = true;
    else if (!a.startsWith('-') && !out.command) out.command = a;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

/**
 * The release archive for a platform. Names must match `artifactName` in
 * desktop/electron-builder.config.cjs. Windows on ARM runs the x64 build emulated.
 */
export function assetFor(platform, arch, version) {
  if (platform === 'darwin') {
    if (arch !== 'arm64' && arch !== 'x64') return null;
    return `${PRODUCT_NAME}-${version}-mac-${arch}.zip`;
  }
  if (platform === 'win32') return `${PRODUCT_NAME}-${version}-win-x64.zip`;
  return null;
}

export function defaultTarget(platform, env = process.env, home = homedir()) {
  if (platform === 'darwin') return join(home, 'Applications', `${PRODUCT_NAME}.app`);
  if (platform === 'win32') {
    const local = env.LOCALAPPDATA || join(home, 'AppData', 'Local');
    return join(local, 'Programs', PRODUCT_NAME);
  }
  return null;
}

/** Start-menu shortcut that `install` creates on Windows. */
export function startMenuShortcut(env = process.env, home = homedir()) {
  const roaming = env.APPDATA || join(home, 'AppData', 'Roaming');
  return join(roaming, 'Microsoft', 'Windows', 'Start Menu', 'Programs', `${PRODUCT_NAME}.lnk`);
}

/**
 * Expected SHA-256 for `asset`, from desktop-checksums.json content. Throws
 * with a user-facing reason when the record cannot vouch for this asset.
 */
export function expectedChecksum(json, version, asset) {
  if (!json) {
    throw new Error(
      'This cockpit install carries no desktop app checksums (a source checkout, or a version published ' +
        'before the desktop app). Build the app from source with `npm run desktop:build` instead.',
    );
  }
  if (json.version !== version) {
    throw new Error(`desktop-checksums.json is for ${json.version}, but this cockpit is ${version}. Reinstall cockpit.`);
  }
  const sha = json.files?.[asset];
  if (!/^[0-9a-f]{64}$/.test(sha || '')) throw new Error(`No checksum recorded for ${asset}.`);
  return sha;
}

// ─────────────────────────────────────────────────────────
// IO
// ─────────────────────────────────────────────────────────

function run(file, args, opts = {}) {
  return new Promise((resolvePromise, reject) => {
    execFile(file, args, { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...opts }, (err, stdout, stderr) => {
      if (err) reject(new Error(`${basename(file)} failed: ${(stderr || err.message).toString().trim()}`));
      else resolvePromise(stdout.toString());
    });
  });
}

/** Native arch even when this node runs under Rosetta. */
async function nativeArch(platform) {
  if (platform !== 'darwin' || process.arch === 'arm64') return process.arch;
  try {
    return (await run('/usr/sbin/sysctl', ['-n', 'hw.optional.arm64'])).trim() === '1' ? 'arm64' : process.arch;
  } catch {
    return process.arch;
  }
}

/** The zip to install for `--from`: the path itself, or `asset` inside a directory. */
export function localArchive(from, asset) {
  const file = existsSync(from) && statSync(from).isDirectory() ? join(from, asset) : from;
  if (!existsSync(file)) {
    throw new Error(`No ${basename(file)} at ${dirname(file)}. Build it with \`npm run desktop:build\` first.`);
  }
  return file;
}

function readChecksums(root) {
  try {
    return JSON.parse(readFileSync(join(root, 'desktop-checksums.json'), 'utf8'));
  } catch {
    return null;
  }
}

/** Stream `url` to `dest`, returning its SHA-256. */
export async function download(url, dest, { onProgress } = {}) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  const total = Number(res.headers.get('content-length')) || 0;
  const hash = createHash('sha256');
  let received = 0;
  const body = Readable.fromWeb(res.body);
  body.on('data', (chunk) => {
    hash.update(chunk);
    received += chunk.length;
    onProgress?.(received, total);
  });
  await pipeline(body, createWriteStream(dest));
  return hash.digest('hex');
}

/** Unpack a release zip into `dir`; returns the path of the app inside it. */
async function extract(platform, zip, dir) {
  if (platform === 'darwin') {
    // ditto keeps the bundle's symlinks and code signature intact; unzip may not.
    await run('/usr/bin/ditto', ['-x', '-k', zip, dir]);
    const app = join(dir, `${PRODUCT_NAME}.app`);
    if (!existsSync(app)) throw new Error(`archive did not contain ${PRODUCT_NAME}.app`);
    return app;
  }
  // bsdtar ships with Windows 10 1803+ and reads zip archives.
  await run(join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe'), ['-xf', zip, '-C', dir]);
  if (existsSync(join(dir, `${PRODUCT_NAME}.exe`))) return dir;
  throw new Error(`archive did not contain ${PRODUCT_NAME}.exe`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** rename that rides out Windows' transient locks (antivirus scans, Explorer). */
async function renameRetry(from, to) {
  for (let attempt = 0; ; attempt++) {
    try {
      return renameSync(from, to);
    } catch (e) {
      const locked = e.code === 'EPERM' || e.code === 'EACCES' || e.code === 'EBUSY';
      if (!locked || attempt >= 20) {
        if (locked) e.message = `${e.message} — is the ${PRODUCT_NAME} desktop app still running? Quit it and retry.`;
        throw e;
      }
      await sleep(250);
    }
  }
}

/**
 * Put `fresh` at `target`, keeping the old copy until the new one is in place
 * so a failure never leaves the user with no app at all.
 */
async function swapInto(fresh, target) {
  const old = existsSync(target) ? `${target}.old-${Date.now()}` : null;
  if (old) await renameRetry(target, old);
  try {
    await renameRetry(fresh, target);
  } catch (e) {
    if (old) await renameRetry(old, target).catch(() => {});
    throw e;
  }
  if (old) rmSync(old, { recursive: true, force: true });
}

const LSREGISTER =
  '/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister';

/**
 * Tell LaunchServices about an installed (or removed) bundle.
 *
 * The app lands at its target by a rename from a hidden staging directory,
 * which Finder never notices, so without this it is missing from the
 * Applications list / Launchpad until something else makes macOS rescan.
 * Best effort: a failure here never fails the install.
 */
export async function registerWithLaunchServices(path, { unregister = false } = {}) {
  try {
    await run(LSREGISTER, unregister ? ['-u', path] : ['-f', '-R', '-trusted', path]);
  } catch {
    // Not fatal: the app still runs; it only shows up in the list later.
  }
}

function psQuote(s) {
  return `'${String(s).replace(/'/g, "''")}'`;
}

async function createShortcut(lnk, exe) {
  mkdirSync(dirname(lnk), { recursive: true });
  const script =
    `$s = (New-Object -ComObject WScript.Shell).CreateShortcut(${psQuote(lnk)}); ` +
    `$s.TargetPath = ${psQuote(exe)}; $s.WorkingDirectory = ${psQuote(dirname(exe))}; $s.Save()`;
  await run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script]);
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

async function waitForExit(pid) {
  const deadline = Date.now() + WAIT_PID_TIMEOUT_MS;
  while (pidAlive(pid)) {
    if (Date.now() > deadline) throw new Error(`process ${pid} did not exit within ${WAIT_PID_TIMEOUT_MS / 1000}s`);
    await sleep(200);
  }
}

function launch(platform, target) {
  const child =
    platform === 'darwin'
      ? spawn('/usr/bin/open', [target], { detached: true, stdio: 'ignore' })
      : spawn(join(target, `${PRODUCT_NAME}.exe`), [], { detached: true, stdio: 'ignore', windowsHide: false });
  child.unref();
}

// ─────────────────────────────────────────────────────────
// Commands
// ─────────────────────────────────────────────────────────

/**
 * Get the app for `version` into `staging` — downloaded and verified, or taken
 * from a local build — and unpack it there. Returns the unpacked app's path.
 */
async function prepare({ platform, root, base, version, asset, from, staging, log }) {
  const local = from ? localArchive(resolve(from), asset) : null;
  const sha = local ? null : expectedChecksum(readChecksums(root), version, asset);
  let archive = local;
  if (local) {
    log(`Using local build ${local}`);
  } else {
    archive = join(staging, asset);
    const url = `${base.replace(/\/$/, '')}/v${version}/${asset}`;
    log(`Downloading ${asset}…`);
    let lastPct = -1;
    const actual = await download(url, archive, {
      onProgress: (got, total) => {
        const pct = total ? Math.floor((got / total) * 10) * 10 : -1;
        if (pct > lastPct) {
          lastPct = pct;
          log(`  ${pct}%`);
        }
      },
    });
    if (actual !== sha) throw new Error(`Checksum mismatch for ${asset}: expected ${sha}, got ${actual}. Nothing was installed.`);
    log('Checksum verified.');
  }
  const unpacked = join(staging, 'unpacked');
  mkdirSync(unpacked);
  const app = await extract(platform, archive, unpacked);
  if (!local) rmSync(archive, { force: true });
  return app;
}

/** Put an unpacked app in place and make the OS aware of it. */
async function finishInstall({ platform, app, dest, register }) {
  await swapInto(app, dest);
  if (platform === 'darwin' && register) await registerWithLaunchServices(dest);
  if (platform === 'win32') await createShortcut(startMenuShortcut(), join(dest, `${PRODUCT_NAME}.exe`));
}

async function resolveRequest({ platform, root, target }) {
  const version = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version;
  const dest = target ? resolve(target) : defaultTarget(platform);
  const asset = assetFor(platform, await nativeArch(platform), version);
  if (!dest || !asset) throw new Error(`The desktop app is available for macOS and Windows only (this is ${platform}).`);
  return { version, dest, asset };
}

/**
 * Download, verify and install. `install` and `update` are the same
 * operation; `update` only insists that something is already there.
 *
 * `from` installs a local build instead (a zip, or a directory holding the
 * zip for this platform such as desktop/dist). Nothing is downloaded, so there
 * is no checksum to hold it to: it is the user's own build.
 */
export async function installApp({
  platform = process.platform,
  root = PROJECT_ROOT,
  base = process.env.COCKPIT_APP_DOWNLOAD_BASE || RELEASE_BASE,
  target = null,
  requireExisting = false,
  from = null,
  register = true,
  log = console.log,
} = {}) {
  const { version, dest, asset } = await resolveRequest({ platform, root, target });
  if (requireExisting && !existsSync(dest)) throw new Error(`No desktop app at ${dest}. Run \`cockpit app install\`.`);
  // Validate before touching the disk, so a refused install leaves nothing behind.
  if (from) localArchive(resolve(from), asset);
  else expectedChecksum(readChecksums(root), version, asset);

  mkdirSync(dirname(dest), { recursive: true });
  // Stage next to the target so the final swap is a same-volume rename.
  const staging = mkdtempSync(join(dirname(dest), `.${PRODUCT_NAME.toLowerCase()}-app-`));
  try {
    const app = await prepare({ platform, root, base, version, asset, from, staging, log });
    await finishInstall({ platform, app, dest, register });
    log(`${PRODUCT_NAME} ${version} installed → ${dest}`);
    return dest;
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
}

// ─────────────────────────────────────────────────────────
// Staged updates (the desktop app's background self-update)
//
// The running app cannot replace itself — Windows locks a running exe — and
// downloading after it quit left users staring at nothing for a minute. So the
// update is split: `--stage` downloads, verifies and unpacks next to the app
// while it keeps running; `--apply` is only the swap, run by the app as it
// quits (or when the user picks "Restart to Update"), and takes seconds.
// ─────────────────────────────────────────────────────────

/** Where a staged update waits. Keep in sync with desktop/src/main.mjs. */
export function stagedDirFor(target) {
  return join(dirname(target), `.${PRODUCT_NAME.toLowerCase()}-update`);
}

/** `{ version, app }` of a complete staged update for `target`, or null. */
export function readStaged(target) {
  try {
    const rec = JSON.parse(readFileSync(join(stagedDirFor(target), 'staged.json'), 'utf8'));
    if (typeof rec?.version !== 'string' || typeof rec?.app !== 'string') return null;
    return existsSync(join(stagedDirFor(target), rec.app)) ? rec : null;
  } catch {
    return null;
  }
}

export async function stageApp({
  platform = process.platform,
  root = PROJECT_ROOT,
  base = process.env.COCKPIT_APP_DOWNLOAD_BASE || RELEASE_BASE,
  target = null,
  from = null,
  log = console.log,
} = {}) {
  const { version, dest, asset } = await resolveRequest({ platform, root, target });
  if (!existsSync(dest)) throw new Error(`No desktop app at ${dest} to update.`);
  const dir = stagedDirFor(dest);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  try {
    const app = await prepare({ platform, root, base, version, asset, from, staging: dir, log });
    // Written last: its presence is what marks the stage complete.
    writeFileSync(join(dir, 'staged.json'), JSON.stringify({ version, app: relative(dir, app) }));
    log(`Staged ${PRODUCT_NAME} ${version} → ${dir}`);
    return { version, dir };
  } catch (e) {
    rmSync(dir, { recursive: true, force: true });
    throw e;
  }
}

export async function applyStaged({ platform = process.platform, target = null, register = true, log = console.log } = {}) {
  const dest = target ? resolve(target) : defaultTarget(platform);
  if (!dest) throw new Error(`The desktop app is available for macOS and Windows only (this is ${platform}).`);
  const staged = readStaged(dest);
  if (!staged) throw new Error(`No staged update for ${dest}.`);
  const dir = stagedDirFor(dest);
  // On failure the stage is kept, so the next quit tries again.
  await finishInstall({ platform, app: join(dir, staged.app), dest, register });
  rmSync(dir, { recursive: true, force: true });
  log(`${PRODUCT_NAME} ${staged.version} installed → ${dest}`);
  return dest;
}

export async function uninstallApp({ platform = process.platform, target = null, register = true, log = console.log } = {}) {
  const dest = target ? resolve(target) : defaultTarget(platform);
  if (!dest) throw new Error(`The desktop app is available for macOS and Windows only (this is ${platform}).`);
  if (!existsSync(dest)) {
    log(`No desktop app at ${dest}.`);
    return;
  }
  // Same rename-first trick as an update: a running app fails here, cleanly.
  const doomed = `${dest}.removing-${Date.now()}`;
  if (platform === 'darwin' && register) await registerWithLaunchServices(dest, { unregister: true });
  await renameRetry(dest, doomed);
  rmSync(doomed, { recursive: true, force: true });
  rmSync(stagedDirFor(dest), { recursive: true, force: true });
  if (platform === 'win32') rmSync(startMenuShortcut(), { force: true });
  log(`Removed ${dest}. Your data in ~/.cockpit is untouched.`);
}

/** Entry point for `cockpit app …`. Returns the process exit code. */
export async function runApp(argv) {
  let opts;
  try {
    opts = parseArgs(argv);
  } catch (e) {
    console.error(e.message);
    console.error(USAGE);
    return 1;
  }
  if (opts.help || !opts.command) {
    console.log(USAGE);
    return opts.help ? 0 : 1;
  }
  try {
    if (opts.waitPid) await waitForExit(opts.waitPid);
    if (opts.command === 'update' && opts.stage) {
      await stageApp({ target: opts.target, from: opts.from });
      return 0;
    }
    if (opts.command === 'update' && opts.apply) {
      const dest = await applyStaged({ target: opts.target });
      if (opts.relaunch) launch(process.platform, dest);
      return 0;
    }
    if (opts.command === 'install' || opts.command === 'update') {
      const dest = await installApp({
        target: opts.target,
        from: opts.from,
        requireExisting: opts.command === 'update',
      });
      if (opts.relaunch) launch(process.platform, dest);
      return 0;
    }
    if (opts.command === 'uninstall') {
      await uninstallApp({ target: opts.target });
      return 0;
    }
    console.error(`Unknown command: ${opts.command}\n`);
    console.error(USAGE);
    return 1;
  } catch (e) {
    console.error(`✗ ${e.message}`);
    // Launched by the app for a self-update: bring the old app back rather
    // than leaving the user with nothing on screen.
    const fallback = opts.target ? resolve(opts.target) : defaultTarget(process.platform);
    if (opts.relaunch && fallback && existsSync(fallback)) launch(process.platform, fallback);
    return 1;
  }
}
