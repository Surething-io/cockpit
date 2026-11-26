// OpenCockpit desktop app — Electron main process.
//
// The app is a dedicated browser for the npm-installed cockpit, nothing more:
//
//   - It never bundles or owns a server. It finds the `cockpit` CLI on the
//     user's PATH (installing the npm package if asked) and drives it with
//     `cockpit start | stop | restart`. The server it starts is the same
//     detached background server a terminal user gets from `cockpit start`,
//     so closing the window or quitting the app leaves it running.
//   - It loads http://localhost:<port>/ exactly like a browser tab would, so
//     the origin gate (src/lib/auth.ts) and every feature work unchanged, and
//     Chrome tabs on the same server can stay open side by side.
//   - It updates itself through `cockpit app update`, never electron-updater:
//     builds are unsigned and Squirrel.Mac refuses to update unsigned apps.
//     The app version is pinned to the npm package version it ships with.
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeTheme, Notification, session, shell } from 'electron';
import { spawn } from 'child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'fs';
import { dirname, join, resolve } from 'path';
import { fileURLToPath, pathToFileURL } from 'url';

import { resolveUserEnv } from './userEnv.mjs';
import {
  MIN_NODE_VERSION,
  NPM_PACKAGE,
  cockpitHomeOf,
  compareVersions,
  findTools,
  portOf,
  probeHealth,
  runTool,
  shellUpdateFor,
} from './cockpitCli.mjs';
import { createStrings } from './strings.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const LAUNCHER_FILE = join(__dirname, 'launcher', 'launcher.html');
const LAUNCHER_URL = pathToFileURL(LAUNCHER_FILE).href;
const PRELOAD_FILE = join(__dirname, 'launcher', 'preload.cjs');
const NODE_DOWNLOAD_URL = 'https://nodejs.org/en/download';
const LOG_LINES_KEPT = 200;

// Granted to the cockpit origin only. Everything else — including pages a
// browser bubble loads in an iframe — is denied.
const ALLOWED_PERMISSIONS = new Set([
  'clipboard-read',
  'clipboard-sanitized-write',
  'fullscreen',
  'media',
  'notifications',
]);

// A development run (`electron .`) gets its own profile, so it neither shares
// the single-instance lock with an installed app nor touches its preferences.
// Must precede the lock: the lock lives in the userData directory.
if (!app.isPackaged) app.setPath('userData', join(app.getPath('appData'), 'OpenCockpit Dev'));

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => focusOrCreateWindow());
}

const t = createStrings(() => app.getLocale());

// ─────────────────────────────────────────────────────────
// State shared by every window
// ─────────────────────────────────────────────────────────

/** @type {{ env: Record<string,string>, source: string } | null} */
let userEnv = null;
/** @type {{ node: string|null, npm: string|null, cockpit: string|null }} */
let tools = { node: null, npm: null, cockpit: null };
let serverOrigin = null;
let busy = false;
let launcherState = { phase: 'checking', log: [] };

function setState(next) {
  launcherState = { ...launcherState, ...next };
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.getURL().startsWith('file:')) win.webContents.send('launcher:state', launcherState);
  }
}

function appendLog(line) {
  const log = [...launcherState.log, line].slice(-LOG_LINES_KEPT);
  setState({ log });
}

function serverUrl() {
  return serverOrigin ? `${serverOrigin}/` : null;
}

/** Bundle the running app lives in: OpenCockpit.app on macOS, the install dir on Windows. */
function installedAppPath() {
  const exe = app.getPath('exe');
  return process.platform === 'darwin' ? resolve(exe, '..', '..', '..') : dirname(exe);
}

// ─────────────────────────────────────────────────────────
// Boot: find cockpit, start it if needed, connect
// ─────────────────────────────────────────────────────────

async function refreshEnvironment() {
  userEnv = await resolveUserEnv();
  tools = findTools(userEnv.env);
}

async function nodeIsUsable() {
  if (!tools.node || !tools.npm) return { ok: false, version: null };
  const { code, output } = await runTool(tools.node, ['-v'], { env: userEnv.env, timeoutMs: 10_000 });
  const version = code === 0 ? output.trim() : null;
  return { ok: version !== null && compareVersions(version, MIN_NODE_VERSION) >= 0, version };
}

/**
 * Walk from "nothing known" to a connected window. Safe to call again at any
 * point (retry, after an install, after the server stopped).
 */
async function boot() {
  if (busy) return;
  busy = true;
  try {
    serverOrigin = null;
    setState({ phase: 'checking', message: null, log: [] });
    await refreshEnvironment();

    if (!tools.cockpit) {
      const node = await nodeIsUsable();
      setState(
        node.ok
          ? { phase: 'need-install' }
          : { phase: 'need-node', nodeVersion: node.version, minNode: MIN_NODE_VERSION },
      );
      return;
    }

    let port = portOf(userEnv.env);
    let health = await probeHealth(port);
    if (!health) {
      setState({ phase: 'starting' });
      const res = await runTool(tools.cockpit, ['start'], { env: userEnv.env, onLine: appendLog });
      port = portOf(userEnv.env);
      health = await probeHealth(port);
      if (!health) {
        setState({ phase: 'failed', message: t('startFailed', { code: res.code }) });
        return;
      }
    }
    connect(port);
  } finally {
    busy = false;
  }
}

function connect(port) {
  serverOrigin = `http://localhost:${port}`;
  setState({ phase: 'connected' });
  for (const win of BrowserWindow.getAllWindows()) {
    if (win.webContents.getURL().startsWith('file:') || win.webContents.getURL() === '') {
      win.loadURL(serverUrl());
    }
  }
  checkForAppUpdate();
}

async function installCockpit() {
  if (busy || !tools.npm) return;
  busy = true;
  let ok = false;
  try {
    setState({ phase: 'installing', log: [] });
    appendLog(`$ npm install -g ${NPM_PACKAGE}`);
    const res = await runTool(tools.npm, ['install', '-g', NPM_PACKAGE], { env: userEnv.env, onLine: appendLog });
    ok = res.code === 0;
    if (!ok) {
      const denied = /EACCES|EPERM/.test(res.output);
      setState({ phase: 'install-failed', message: t(denied ? 'installDenied' : 'installFailed', { code: res.code }) });
    }
  } finally {
    busy = false;
  }
  if (ok) await boot();
}

// ─────────────────────────────────────────────────────────
// Server menu actions
// ─────────────────────────────────────────────────────────

async function serverCommand(command) {
  if (!tools.cockpit) return boot();
  if (command === 'stop') {
    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: [t('stopConfirm'), t('cancel')],
      defaultId: 1,
      cancelId: 1,
      message: t('stopTitle'),
      detail: t('stopDetail'),
    });
    if (response !== 0) return;
  }
  if (command === 'start') return boot();

  serverOrigin = null;
  for (const win of BrowserWindow.getAllWindows()) win.loadFile(LAUNCHER_FILE);
  setState({ phase: command === 'stop' ? 'stopping' : 'restarting', log: [] });
  const res = await runTool(tools.cockpit, [command], { env: userEnv.env, onLine: appendLog });
  if (command === 'stop') {
    setState(res.code === 0 ? { phase: 'stopped' } : { phase: 'failed', message: t('stopFailed', { code: res.code }) });
    return;
  }
  await boot();
}

// ─────────────────────────────────────────────────────────
// Desktop app self-update (via `cockpit app update`)
//
// The app is a thin shell that rarely changes, so "an update exists" means
// "the installed cockpit carries a different shell than this build" (see
// availableShellUpdate), not "cockpit is newer". Checking costs nothing (one
// local request, plus `cockpit app status` once per cockpit version), so it
// runs every few minutes; downloading ~100 MB is the user's call. By default
// an available update is only announced (notification + "Download Update" in
// the menu); "Download Updates Automatically" in the menu, off by default,
// lets it fetch in the background instead.
//
// Downloading stages the update beside the app (`--stage`: download, verify,
// unpack) while the user keeps working. Once staged, the menu offers "Restart
// to Update"; otherwise it is swapped in when the app quits (`--apply`), so
// the next launch is simply the new version.
// ─────────────────────────────────────────────────────────

const UPDATE_CHECK_INTERVAL_MS = 5 * 60_000;
// After a failed automatic download, wait this long before trying again on our
// own: a bad network or checksum must not mean 100 MB every 5 minutes.
const UPDATE_RETRY_AFTER_FAILURE_MS = 60 * 60_000;

/**
 * idle → available → downloading → ready; downloading → failed.
 * @type {{ status: 'idle'|'available'|'downloading'|'ready'|'failed', version: string|null, percent: number, error: string|null, failedAt: number }}
 */
let update = { status: 'idle', version: null, percent: 0, error: null, failedAt: 0 };
let applyingUpdate = false;
let announcedVersion = null;

function setUpdate(next) {
  update = { ...update, ...next };
  buildMenu();
}

// The app's own preferences (not cockpit's: the browser UI has no use for them).
const PREFS_FILE = () => join(app.getPath('userData'), 'preferences.json');
const DEFAULT_PREFS = { autoDownloadUpdates: false };

function readPrefs() {
  try {
    return { ...DEFAULT_PREFS, ...JSON.parse(readFileSync(PREFS_FILE(), 'utf8')) };
  } catch {
    return { ...DEFAULT_PREFS };
  }
}

function writePrefs(next) {
  try {
    mkdirSync(dirname(PREFS_FILE()), { recursive: true });
    writeFileSync(PREFS_FILE(), JSON.stringify({ ...readPrefs(), ...next }, null, 2));
  } catch {
    // Unwritable profile: the choice still applies for this session.
  }
}

/** Where `cockpit app update --stage` leaves its work. Keep in sync with bin/cock-app.mjs#stagedDirFor. */
function stagedUpdateDir() {
  return join(dirname(installedAppPath()), '.opencockpit-update');
}

/** Version of a complete staged update other than the running app, or null. */
function readStagedVersion() {
  try {
    const { version } = JSON.parse(readFileSync(join(stagedUpdateDir(), 'staged.json'), 'utf8'));
    return version && version !== app.getVersion() ? version : null;
  } catch {
    return null;
  }
}

/** Fingerprint of this build's shell, stamped in by desktop/scripts/build.mjs. */
function ownShellHash() {
  try {
    return JSON.parse(readFileSync(join(app.getAppPath(), 'package.json'), 'utf8')).shellHash ?? null;
  } catch {
    return null;
  }
}

/** Run the cockpit CLI detached, so it outlives us (it waits for our exit). */
function spawnCockpitDetached(args) {
  const child =
    process.platform === 'win32'
      ? spawn([tools.cockpit, ...args].map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' '), {
          env: userEnv.env,
          shell: true,
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        })
      : spawn(tools.cockpit, args, { env: userEnv.env, detached: true, stdio: 'ignore' });
  child.unref();
}

function lastLine(output) {
  return (
    String(output || '')
      .trim()
      .split(/\r?\n/)
      .filter((l) => l.trim())
      .pop()
      ?.replace(/^✗\s*/, '') ?? ''
  );
}

// `cockpit app status` only needs asking again once cockpit itself changed,
// which the server's version (one local request) tells us for free.
let shellCheck = { serverVersion: null, version: null };

/**
 * Whether the installed cockpit carries a different desktop shell than this
 * build: returns the version to update to, or null. Most cockpit releases
 * leave the shell unchanged, and then there is nothing to download.
 */
async function availableShellUpdate({ fresh = false } = {}) {
  const health = serverOrigin ? await probeHealth(Number(new URL(serverOrigin).port)) : null;
  if (!health) return { reachable: false, version: null };
  if (!fresh && shellCheck.serverVersion === health.version) return { reachable: true, version: shellCheck.version };
  const res = await runTool(tools.cockpit, ['app', 'status', '--json'], { env: userEnv.env, timeoutMs: 15_000 });
  let pkg = null;
  try {
    pkg = JSON.parse(lastLine(res.output));
  } catch {
    // An older cockpit without `app status`: it records no fingerprint either.
  }
  const version = res.code === 0 ? shellUpdateFor(ownShellHash(), pkg) : null;
  shellCheck = { serverVersion: health.version, version };
  return { reachable: true, version };
}

/**
 * Periodic and on-connect check. Never downloads unless the user opted in;
 * otherwise it only announces, once per version.
 */
async function checkForAppUpdate() {
  if (!app.isPackaged || !tools.cockpit) return;
  if (update.status === 'downloading' || update.status === 'ready') return;
  const { version } = await availableShellUpdate();
  if (!version) return;

  if (readPrefs().autoDownloadUpdates) {
    const recentlyFailed = update.status === 'failed' && Date.now() - update.failedAt < UPDATE_RETRY_AFTER_FAILURE_MS;
    if (!recentlyFailed) await downloadUpdate(version, { manual: false });
    return;
  }
  if (update.status !== 'available' || update.version !== version) setUpdate({ status: 'available', version });
  if (announcedVersion !== version) {
    announcedVersion = version;
    notify(t('updateAvailableTitle'), t('updateAvailableBody', { version }), () => promptDownload());
  }
}

/** "Check for Desktop App Update…" from the menu. */
async function checkForAppUpdateManually() {
  if (!app.isPackaged) {
    dialog.showMessageBox({ message: t('updateDevBuild') });
    return;
  }
  if (update.status === 'ready') return promptRestartToUpdate();
  if (update.status === 'downloading') return;
  const { reachable, version } = await availableShellUpdate({ fresh: true });
  if (!reachable) {
    dialog.showMessageBox({ message: t('updateNeedsServer') });
    return;
  }
  if (!version || !tools.cockpit) {
    dialog.showMessageBox({ message: t('updateNone', { version: app.getVersion() }) });
    return;
  }
  setUpdate({ status: 'available', version });
  await promptDownload();
}

async function promptDownload() {
  if (update.status !== 'available' && update.status !== 'failed') return;
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: [t('download'), t('later')],
    defaultId: 0,
    cancelId: 1,
    message: t('updateAvailableTitle'),
    detail: t('updateAvailableDetail', { current: app.getVersion(), next: update.version }),
  });
  if (response === 0) await downloadUpdate(update.version, { manual: true });
}

/** Stage `version` in the background (`cockpit app update --stage`). */
async function downloadUpdate(version, { manual }) {
  if (update.status === 'downloading' || update.status === 'ready' || !tools.cockpit) return;
  setUpdate({ status: 'downloading', version, percent: 0, error: null });
  const res = await runTool(tools.cockpit, ['app', 'update', '--stage', '--target', installedAppPath()], {
    env: userEnv.env,
    onLine: (line) => {
      const m = /^\s*(\d{1,3})%\s*$/.exec(line);
      if (m && Number(m[1]) !== update.percent) setUpdate({ percent: Number(m[1]) });
    },
  });
  const staged = res.code === 0 ? readStagedVersion() : null;
  if (staged) {
    setUpdate({ status: 'ready', version: staged });
    if (manual) promptRestartToUpdate();
    else notify(t('updateReadyTitle'), t('updateReadyBody', { version: staged }), () => promptRestartToUpdate());
    return;
  }
  const error = lastLine(res.output) || t('updateFailedUnknown', { code: res.code });
  setUpdate({ status: 'failed', error, failedAt: Date.now() });
  if (manual) dialog.showMessageBox({ type: 'error', message: t('updateFailed'), detail: error });
}

function notify(title, body, onClick) {
  if (!Notification.isSupported()) return;
  const note = new Notification({ title, body });
  note.on('click', onClick);
  note.show();
}

async function promptRestartToUpdate() {
  const { response } = await dialog.showMessageBox({
    type: 'info',
    buttons: [t('restartNow'), t('later')],
    defaultId: 0,
    cancelId: 1,
    message: t('updateReadyTitle'),
    detail: t('updateReadyDetail', { current: app.getVersion(), next: update.version }),
  });
  if (response === 0) restartToUpdate();
}

function restartToUpdate() {
  if (update.status !== 'ready' || applyingUpdate) return;
  applyingUpdate = true;
  spawnCockpitDetached(['app', 'update', '--apply', '--target', installedAppPath(), '--wait-pid', String(process.pid), '--relaunch']);
  app.quit();
}

/** On quit, a staged update is swapped in so the next launch is the new version. */
function applyUpdateOnQuit() {
  if (update.status !== 'ready' || applyingUpdate || !tools.cockpit) return;
  applyingUpdate = true;
  spawnCockpitDetached(['app', 'update', '--apply', '--target', installedAppPath(), '--wait-pid', String(process.pid)]);
}

function startUpdateChecks() {
  if (!app.isPackaged) return;
  // An update downloaded in an earlier session that never got applied.
  const staged = readStagedVersion();
  if (staged) setUpdate({ status: 'ready', version: staged });
  setInterval(() => checkForAppUpdate(), UPDATE_CHECK_INTERVAL_MS).unref?.();
}

/** Update entries for the menu: the action for the current state, plus the opt-in. */
function updateMenuItems() {
  const action = (() => {
    switch (update.status) {
      case 'available':
        return { label: t('menuUpdateAvailable', { version: update.version }), click: () => downloadUpdate(update.version, { manual: true }) };
      case 'downloading':
        return { label: t('menuUpdateDownloading', { percent: update.percent }), enabled: false };
      case 'ready':
        return { label: t('menuUpdateReady', { version: update.version }), click: () => restartToUpdate() };
      case 'failed':
        return { label: t('menuUpdateRetry'), click: () => downloadUpdate(update.version, { manual: true }) };
      default:
        return { label: t('menuCheckUpdate'), click: () => checkForAppUpdateManually() };
    }
  })();
  return [
    action,
    {
      label: t('menuAutoDownload'),
      type: 'checkbox',
      checked: readPrefs().autoDownloadUpdates,
      click: (item) => {
        writePrefs({ autoDownloadUpdates: item.checked });
        if (item.checked) checkForAppUpdate();
      },
    },
  ];
}

// ─────────────────────────────────────────────────────────
// Windows and navigation policy
// ─────────────────────────────────────────────────────────

function originOf(url) {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

function isAppUrl(url) {
  return url === LAUNCHER_URL || (serverOrigin !== null && originOf(url) === serverOrigin);
}

function openExternalSafe(url) {
  if (/^(https?|mailto):/i.test(url)) shell.openExternal(url);
}

function webPreferences() {
  return {
    preload: PRELOAD_FILE,
    contextIsolation: true,
    nodeIntegration: false,
    sandbox: true,
    spellcheck: false,
  };
}

// The window keeps its native title bar; its light/dark look follows cockpit's
// own theme setting (System / Light / Dark) through nativeTheme.themeSource,
// which takes exactly those three values. The page reports the setting (see
// public/boot.js); the last one is remembered so the next launch — launcher
// page and window background included — starts in the right shade.
const THEME_SOURCES = new Set(['system', 'light', 'dark']);

function applyThemeSource(source) {
  if (!THEME_SOURCES.has(source) || nativeTheme.themeSource === source) return;
  nativeTheme.themeSource = source;
  writePrefs({ themeSource: source });
}

function windowBackground() {
  // launcher.css --bg, so the window never flashes the other shade.
  return nativeTheme.shouldUseDarkColors ? '#0b0d10' : '#f6f7f9';
}

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 480,
    title: 'OpenCockpit',
    backgroundColor: windowBackground(),
    show: false,
    webPreferences: webPreferences(),
  });
  win.once('ready-to-show', () => win.show());

  // A server that went away mid-session: show the launcher instead of
  // Chromium's error page, so "Start" is one click away.
  win.webContents.on('did-fail-load', (_e, code, _desc, url, isMainFrame) => {
    if (!isMainFrame || code === -3 /* ERR_ABORTED: superseded navigation */) return;
    if (serverOrigin && originOf(url) === serverOrigin) {
      serverOrigin = null;
      setState({ phase: 'stopped' });
      win.loadFile(LAUNCHER_FILE);
    }
  });

  if (serverUrl()) win.loadURL(serverUrl());
  else win.loadFile(LAUNCHER_FILE);
  return win;
}

function focusOrCreateWindow() {
  const win = BrowserWindow.getAllWindows()[0];
  if (!win) return createWindow();
  if (win.isMinimized()) win.restore();
  win.focus();
  return win;
}

// Applies to every webContents, including windows a page opens itself.
app.on('web-contents-created', (_e, contents) => {
  // Top-level navigation stays on cockpit. A previewed HTML page, a link
  // without target=_blank, or a stray redirect would otherwise replace the
  // whole app with a foreign page that still has our window.
  contents.on('will-navigate', (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternalSafe(url);
  });
  contents.setWindowOpenHandler(({ url }) => {
    if (serverOrigin && originOf(url) === serverOrigin) {
      return { action: 'allow', overrideBrowserWindowOptions: { width: 1280, height: 860, webPreferences: webPreferences() } };
    }
    openExternalSafe(url);
    return { action: 'deny' };
  });
});

function installPermissionPolicy() {
  const allowed = (permission, url) => ALLOWED_PERMISSIONS.has(permission) && serverOrigin !== null && originOf(url) === serverOrigin;
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback, details) =>
    callback(allowed(permission, details.requestingUrl)),
  );
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    allowed(permission, requestingOrigin),
  );
}

// ─────────────────────────────────────────────────────────
// Launcher IPC — only the local launcher page may call these
// ─────────────────────────────────────────────────────────

function fromLauncher(event) {
  return event.senderFrame?.url === LAUNCHER_URL;
}

function installIpc() {
  // Cockpit's theme setting, reported by the page whenever it changes. Only the
  // top frame of the cockpit origin may send it, and only one of three words:
  // nothing else crosses this channel.
  ipcMain.on('desktop:theme', (event, source) => {
    const frame = event.senderFrame;
    if (!frame || frame.parent !== null || !serverOrigin || originOf(frame.url) !== serverOrigin) return;
    applyThemeSource(source);
  });
  ipcMain.handle('launcher:get-state', (event) => (fromLauncher(event) ? launcherState : null));
  ipcMain.handle('launcher:strings', (event) => (fromLauncher(event) ? t.all() : null));
  ipcMain.handle('launcher:action', async (event, action) => {
    if (!fromLauncher(event)) return;
    switch (action) {
      case 'retry':
      case 'start':
        return boot();
      case 'install':
        return installCockpit();
      case 'open-node-site':
        return shell.openExternal(NODE_DOWNLOAD_URL);
      case 'open-logs':
        return shell.openPath(join(cockpitHomeOf(userEnv?.env ?? process.env), 'logs'));
      default:
        return undefined;
    }
  });
}

// ─────────────────────────────────────────────────────────
// Menu
// ─────────────────────────────────────────────────────────

function buildMenu() {
  const isMac = process.platform === 'darwin';
  const updateItems = updateMenuItems();
  /** @type {Electron.MenuItemConstructorOptions[]} */
  const template = [
    ...(isMac
      ? [
          {
            role: 'appMenu',
            submenu: [
              { role: 'about' },
              ...updateItems,
              { type: 'separator' },
              { role: 'services' },
              { type: 'separator' },
              { role: 'hide' },
              { role: 'hideOthers' },
              { role: 'unhide' },
              { type: 'separator' },
              { role: 'quit' },
            ],
          },
        ]
      : []),
    {
      label: t('menuFile'),
      submenu: [
        { label: t('menuNewWindow'), accelerator: 'CmdOrCtrl+N', click: () => createWindow() },
        { role: 'close' },
        ...(isMac ? [] : [{ type: 'separator' }, { role: 'quit' }]),
      ],
    },
    { role: 'editMenu' },
    {
      label: t('menuView'),
      submenu: [
        { role: 'reload' },
        { role: 'forceReload' },
        { role: 'toggleDevTools' },
        { type: 'separator' },
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' },
      ],
    },
    {
      label: t('menuServer'),
      submenu: [
        { label: t('menuStart'), click: () => serverCommand('start') },
        { label: t('menuRestart'), click: () => serverCommand('restart') },
        { label: t('menuStop'), click: () => serverCommand('stop') },
        { type: 'separator' },
        { label: t('menuOpenInBrowser'), click: () => serverUrl() && shell.openExternal(serverUrl()) },
        {
          label: t('menuOpenLogs'),
          click: () => shell.openPath(join(cockpitHomeOf(userEnv?.env ?? process.env), 'logs')),
        },
      ],
    },
    ...(isMac ? [{ role: 'windowMenu' }] : [{ label: t('menuHelp'), submenu: updateItems }]),
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// ─────────────────────────────────────────────────────────
// Lifecycle
// ─────────────────────────────────────────────────────────

// Lets the web UI tell it is running in the desktop app, should it ever need
// to; feature detection, never a version check.
app.userAgentFallback = `${app.userAgentFallback} CockpitDesktop/${app.getVersion()}`;

app.whenReady().then(() => {
  const savedTheme = readPrefs().themeSource;
  if (THEME_SOURCES.has(savedTheme)) nativeTheme.themeSource = savedTheme;
  installPermissionPolicy();
  installIpc();
  buildMenu();
  createWindow();
  boot();
  startUpdateChecks();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// The server is not ours to stop: like closing a browser, quitting only closes
// windows. macOS keeps the app in the Dock as usual.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('will-quit', () => applyUpdateOnQuit());
