/**
 * OpenCockpit Bridge — service worker.
 *
 * Trust model (the reason this file looks the way it does):
 *   - Commands arrive ONLY over Native Messaging from the OpenCockpit native
 *     host (`com.opencockpit.bridge`), which relays from Cockpit servers that
 *     authenticated with a per-boot token. No web page — including Cockpit's
 *     own UI — can send this worker a command: there is no
 *     externally_connectable, no onMessage handler, no content-script channel.
 *   - Commands may only touch two kinds of target:
 *       bubble — a frame named `cockpit-bubble-<id>` whose parent frame is the
 *                commanding Cockpit instance's own origin, inside a tab that is
 *                showing that origin;
 *       tab    — any ordinary tab, but only once that tab is granted: Cockpit
 *                opened it, or the user allowed it. The first command on any
 *                other tab brings it to the front and waits for the user to
 *                answer in the toolbar popup.
 *   - Nothing rewrites response headers, injects cookies or disguises frames.
 *     Pages run exactly as they would without the extension.
 *
 * Execution:
 *   - DOM work runs in the extension's isolated world via chrome.scripting
 *     (page-core.js). No debugger, so no "is debugging this browser" banner.
 *   - chrome.debugger is attached on demand only for what needs it (trusted
 *     input, dialogs, uploads, CDP screenshots, emulation, capture … — see
 *     tab-tools.js). It detaches 5 s after its last use unless something
 *     lives only as long as the session (debugger-session.js).
 *   - Runtime.enable is never left on outside an explicit capture: it is the
 *     usual tell that bot-detection scripts look for.
 *
 * UI: granted tab — colour icon with a green dot; not granted — grey
 * icon; asking — amber "?". The short id (what users type in
 * `cockpit browser <id>`) is in the tooltip and the toolbar popup
 * (popup.html), which also copies it, grants / revokes the tab, lists granted
 * tabs, and hosts the approval prompt. It talks to this worker only through
 * storage. `cockpit browser <id> release` revokes a grant from the CLI.
 */

import {
  sessions, attach, touch, detach, cdp, forgetSession, hasOverrides,
  onSessionsChanged, debuggingTabs, notifySessions,
} from './debugger-session.js';
import * as tools from './tab-tools.js';

const NATIVE_HOST = 'com.opencockpit.bridge';
const PROTOCOL = 1;
// Capture keeps the debugger (and Chrome's "is debugging" bar) on, so it ends
// soon after the agent stops reading it — longer while a recording runs.
const CAPTURE_IDLE_MS = 2 * 60_000;
const MAX_CAPTURE_ENTRIES = 500;
const MAX_BODY_SIZE = 128 * 1024;
const GROUP_TITLE = 'Cockpit';
const LOG = '[OpenCockpit Bridge]';

const VERSION = chrome.runtime.getManifest().version;

// ============================================================================
// Native host connection
// ============================================================================

/** @type {chrome.runtime.Port | null} */
let nativePort = null;
let nativeStatus = { connected: false, error: null };
let reconnectTimer = null;

/** instanceId → { id, port, origins: Set<string> } */
const instances = new Map();

function instanceOrigins(port) {
  return new Set([`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`]);
}

function connectNative() {
  if (nativePort) return;
  clearTimeout(reconnectTimer);
  try {
    nativePort = chrome.runtime.connectNative(NATIVE_HOST);
  } catch (e) {
    nativePort = null;
    setNativeStatus(false, e.message);
    scheduleReconnect();
    return;
  }
  nativePort.onMessage.addListener(onNativeMessage);
  nativePort.onDisconnect.addListener(() => {
    const err = chrome.runtime.lastError?.message || 'native host exited';
    nativePort = null;
    instances.clear();
    chrome.storage.session.set({ serverCount: 0 }).catch(() => {});
    setNativeStatus(false, err);
    scheduleReconnect();
  });
  nativePort.postMessage({ type: 'hello', protocol: PROTOCOL, version: VERSION });
  setNativeStatus(true, null);
}

function scheduleReconnect() {
  clearTimeout(reconnectTimer);
  reconnectTimer = setTimeout(connectNative, 5000);
}

function setNativeStatus(connected, error) {
  nativeStatus = { connected, error };
  chrome.storage.session.set({ nativeStatus }).catch(() => {});
  if (!connected) console.warn(LOG, 'native host unavailable:', error);
  refreshActionTitle();
}

function sendToInstance(instanceId, msg) {
  if (!nativePort) return;
  try {
    nativePort.postMessage({ type: 'msg', instance: instanceId, msg });
  } catch (e) {
    console.warn(LOG, 'postMessage to native host failed:', e.message);
  }
}

function onNativeMessage(message) {
  if (!message || typeof message !== 'object') return;
  if (message.type === 'instances') {
    const next = new Map();
    for (const inst of message.instances || []) {
      if (!inst || !inst.id || !inst.port) continue;
      const prev = instances.get(String(inst.id));
      next.set(String(inst.id), { id: String(inst.id), port: inst.port, origins: instanceOrigins(inst.port), cli: prev?.cli || 'cockpit' });
    }
    const added = [...next.keys()].filter(id => !instances.has(id));
    instances.clear();
    for (const [id, inst] of next) instances.set(id, inst);
    for (const id of [...cliByInstance.keys()]) if (!next.has(id)) cliByInstance.delete(id);
    persistState();
    chrome.storage.session.set({ serverCount: instances.size }).catch(() => {});
    for (const id of added) {
      sendToInstance(id, { type: 'hello', protocol: PROTOCOL, version: VERSION, browser: browserName() });
      ready.then(() => sendTabsTo(id));
    }
    refreshActionTitle();
    return;
  }
  if (message.type === 'msg') {
    const inst = instances.get(String(message.instance));
    if (!inst) return;
    handleServerMessage(inst, message.msg || {}).catch(e => console.warn(LOG, 'message failed:', e));
  }
}

function browserName() {
  const brands = navigator.userAgentData?.brands || [];
  const named = brands.find(b => !/Not.?A.?Brand|Chromium/i.test(b.brand));
  return named?.brand || brands[0]?.brand || 'Chromium';
}

// Alarms wake the worker if it was suspended while the host was missing.
chrome.alarms.create('cockpit-reconnect', { periodInMinutes: 1 });
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'cockpit-reconnect') connectNative();
});
chrome.runtime.onStartup.addListener(connectNative);
chrome.runtime.onInstalled.addListener(connectNative);

// ============================================================================
// Tabs: every tab is addressable, control is granted per tab
// ============================================================================
//
// Addressing and authorization are separate:
//   - Every ordinary tab (http/https/file, not a Cockpit page) gets a stable
//     `tab-<uuid>` the server turns into a 4-letter short id. It survives
//     worker restarts, extension reloads and Cockpit restarts (storage.local).
//     Chrome renumbers tabs when the browser restarts; restored tabs are
//     matched back to their previous id by URL (in order), the way a
//     restarted Cockpit re-adopts its terminals. Anything unmatched gets a new
//     id — an old id never lands on a different page.
//   - Acting on a tab requires that tab to be granted: by the user (popup /
//     approval prompt) or because Cockpit opened it. The grant belongs to the
//     tab, not the site: other tabs on the same site still ask.
//   - Reading the tab list (url / title) needs no approval.

/** chromeTabId → fullId */
const tabIds = new Map();
/** chromeTabId → last known URL (for re-matching after a browser restart) */
const tabUrls = new Map();
/** chromeTabIds Cockpit may act on */
const grantedTabs = new Set();
/** chromeTabId → { projectCwd } for tabs Cockpit opened */
const openedTabs = new Map();
/** fullId → shortId, as assigned by the server */
const shortIds = new Map();
/** Tabs of the previous browser session, waiting to be matched: [{ fullId, url, granted, opened }] */
let restorePool = [];
/**
 * instanceId → the CLI users type for it (`cockpit` / `cockpit-dev`). Several
 * Cockpit servers can be connected at once; the primary command shown to the
 * user is the production one when present.
 */
const cliByInstance = new Map();
function cliNames() {
  const names = [...new Set(cliByInstance.values())];
  return names.sort((a, b) => (a === 'cockpit' ? -1 : b === 'cockpit' ? 1 : a.localeCompare(b)));
}
function setInstanceCli(instanceId, cli) {
  if (typeof cli !== 'string' || cliByInstance.get(instanceId) === cli) return;
  cliByInstance.set(instanceId, cli);
  persistState();
  updateAllBadges();
}

const ready = chrome.storage.local.get('bridgeState').then(({ bridgeState: s }) => {
  if (!s) return;
  for (const [k, v] of Object.entries(s.tabIds || {})) tabIds.set(Number(k), v);
  for (const [k, v] of Object.entries(s.tabUrls || {})) tabUrls.set(Number(k), v);
  for (const k of s.grantedTabs || []) grantedTabs.add(Number(k));
  for (const [k, v] of Object.entries(s.openedTabs || {})) openedTabs.set(Number(k), v);
  for (const [k, v] of Object.entries(s.shortIds || {})) shortIds.set(k, v);
  restorePool = Array.isArray(s.restorePool) ? s.restorePool : [];
}).catch(() => {}).then(() => connectNative());

let persistTimer = null;
function persistState() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(() => {
    chrome.storage.local.set({
      bridgeState: {
        tabIds: Object.fromEntries(tabIds),
        tabUrls: Object.fromEntries(tabUrls),
        grantedTabs: [...grantedTabs],
        openedTabs: Object.fromEntries(openedTabs),
        shortIds: Object.fromEntries(shortIds),
        restorePool,
        clis: cliNames(),
      },
    }).catch(() => {});
  }, 100);
}

// Browser start: tab numbers were reassigned. Park the previous session's tabs
// in a pool; restored tabs claim their old id (and grant) by URL as they show up.
chrome.runtime.onStartup.addListener(async () => {
  await ready;
  restorePool = [...tabIds.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([tabId, fullId]) => ({
      fullId,
      url: tabUrls.get(tabId) || '',
      granted: grantedTabs.has(tabId),
      opened: openedTabs.get(tabId) || null,
    }))
    .filter((e) => e.url);
  tabIds.clear();
  tabUrls.clear();
  grantedTabs.clear();
  openedTabs.clear();
  persistState();
  // Session restore finishes quickly; whatever is left after that is gone for good.
  setTimeout(() => {
    for (const e of restorePool) shortIds.delete(e.fullId);
    restorePool = [];
    persistState();
  }, 120_000);
  broadcastTabs();
});

function originKey(url) {
  try {
    const u = new URL(url);
    return u.protocol === 'file:' ? 'file://' : u.origin;
  } catch {
    return null;
  }
}

function isCockpitUrl(url) {
  const o = originKey(url || '');
  for (const inst of instances.values()) if (inst.origins.has(o)) return true;
  return false;
}

function tabUrl(tab) {
  return tab?.url || tab?.pendingUrl || '';
}

function isAddressable(tab) {
  const url = tabUrl(tab);
  return !!tab?.id && /^(https?|file):/.test(url) && !isCockpitUrl(url);
}

function ensureTabId(tab) {
  let id = tabIds.get(tab.id);
  if (!id) {
    const url = tabUrl(tab);
    const i = restorePool.findIndex((e) => e.url === url);
    if (i >= 0) {
      const [prev] = restorePool.splice(i, 1);
      id = prev.fullId;
      if (prev.granted) grantedTabs.add(tab.id);
      if (prev.opened) openedTabs.set(tab.id, prev.opened);
    } else {
      id = 'tab-' + crypto.randomUUID();
    }
    tabIds.set(tab.id, id);
    persistState();
  }
  const url = tabUrl(tab);
  if (url && tabUrls.get(tab.id) !== url) {
    tabUrls.set(tab.id, url);
    persistState();
  }
  return id;
}

function isAllowed(tab) {
  return grantedTabs.has(tab.id);
}

async function tabsSnapshot() {
  const out = [];
  for (const tab of await chrome.tabs.query({})) {
    if (!isAddressable(tab)) continue;
    const opened = openedTabs.get(tab.id);
    out.push({
      fullId: ensureTabId(tab),
      chromeTabId: tab.id,
      url: tabUrl(tab),
      title: tab.title || '',
      allowed: isAllowed(tab),
      active: !!tab.active,
      debugging: !!sessions.get(tab.id)?.attached,
      origin: opened ? 'opened' : undefined,
      projectCwd: opened?.projectCwd,
    });
  }
  return out;
}

async function sendTabsTo(instanceId) {
  sendToInstance(instanceId, { type: 'tabs', tabs: await tabsSnapshot() });
}

let broadcastTimer = null;
function broadcastTabs() {
  clearTimeout(broadcastTimer);
  broadcastTimer = setTimeout(async () => {
    const tabs = await tabsSnapshot();
    for (const id of instances.keys()) sendToInstance(id, { type: 'tabs', tabs });
  }, 250);
}

function findTabByFullId(fullId) {
  for (const [tabId, id] of tabIds) if (id === fullId) return tabId;
  return null;
}

/** Server reply to a tab report: short ids to show, and ids to regenerate on a collision. */
async function applyTabIds(ids, reroll) {
  for (const [fullId, shortId] of Object.entries(ids || {})) shortIds.set(fullId, shortId);
  let rerolled = false;
  for (const fullId of reroll || []) {
    const tabId = findTabByFullId(fullId);
    if (tabId == null) continue;
    shortIds.delete(fullId);
    tabIds.set(tabId, 'tab-' + crypto.randomUUID());
    rerolled = true;
  }
  persistState();
  if (rerolled) broadcastTabs();
  await updateAllBadges();
}

function grantTab(tabId) {
  grantedTabs.add(tabId);
  persistState();
}

async function revokeTab(tabId) {
  grantedTabs.delete(tabId);
  persistState();
  await detach(tabId);
}

chrome.tabs.onCreated.addListener(() => broadcastTabs());

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  bubbleCache.forEach((v, k) => { if (v.tabId === tabId) bubbleCache.delete(k); });
  forgetSession(tabId);
  settleApproval(tabId, 'deny');
  // A closing window may be the browser quitting: keep its tabs' records so
  // the restored tabs can reclaim their ids on the next start. (Chrome never
  // reuses a tab number within a session, so a kept record cannot misfire.)
  if (!removeInfo?.isWindowClosing) {
    const fullId = tabIds.get(tabId);
    if (fullId) shortIds.delete(fullId);
    tabIds.delete(tabId);
    tabUrls.delete(tabId);
    grantedTabs.delete(tabId);
    openedTabs.delete(tabId);
    persistState();
  }
  broadcastTabs();
});

chrome.tabs.onUpdated.addListener((tabId, info, tab) => {
  if (info.url && tabIds.has(tabId)) { tabUrls.set(tabId, info.url); persistState(); }
  if (info.url || info.title) broadcastTabs();
  if (info.status === 'loading' || info.url) updateBadge(tab);
});

// ── Toolbar icon ──────────────────────────────────────────────────────────
// Granted tab: colour icon with a green dot drawn in. Not granted: greyed-out icon,
// no badge (Cockpit would ask first). Asking now: amber "?".
// The short id is in the tooltip and the popup. Clicking opens popup.html.

const ICON_PATHS = { 16: 'icons/icon16.png', 48: 'icons/icon48.png', 128: 'icons/icon128.png' };
let grayIcons = null;

let linkedIcons = null;

async function loadIcon(size, file) {
  const bmp = await createImageBitmap(await (await fetch(chrome.runtime.getURL(file))).blob());
  const ctx = new OffscreenCanvas(size, size).getContext('2d');
  ctx.drawImage(bmp, 0, 0, size, size);
  return ctx;
}

const ICON_SOURCES = [[16, 'icons/icon16.png'], [32, 'icons/icon48.png']];

async function grayIconSet() {
  if (grayIcons) return grayIcons;
  const out = {};
  for (const [size, file] of ICON_SOURCES) {
    const ctx = await loadIcon(size, file);
    const img = ctx.getImageData(0, 0, size, size);
    for (let i = 0; i < img.data.length; i += 4) {
      const l = 0.3 * img.data[i] + 0.59 * img.data[i + 1] + 0.11 * img.data[i + 2];
      img.data[i] = img.data[i + 1] = img.data[i + 2] = l;
      img.data[i + 3] = Math.round(img.data[i + 3] * 0.45);
    }
    out[size] = img;
  }
  grayIcons = out;
  return out;
}

let drivingIcons = null;

/** Colour icon with a small green dot in the bottom-right corner. */
async function linkedIconSet() {
  if (linkedIcons) return linkedIcons;
  linkedIcons = await dottedIconSet('#16a34a');
  return linkedIcons;
}

/** Orange dot: the debugger is attached to this tab right now. */
async function drivingIconSet() {
  if (drivingIcons) return drivingIcons;
  drivingIcons = await dottedIconSet('#ea580c');
  return drivingIcons;
}

async function dottedIconSet(color) {
  const out = {};
  for (const [size, file] of ICON_SOURCES) {
    const ctx = await loadIcon(size, file);
    const r = size * 0.2;                 // dot radius
    const cx = size - r - size / 32, cy = size - r - size / 32;
    // White ring separates the dot from the icon underneath.
    ctx.beginPath();
    ctx.arc(cx, cy, r + Math.max(1, size / 16), 0, Math.PI * 2);
    ctx.fillStyle = '#ffffff';
    ctx.fill();
    ctx.beginPath();
    ctx.arc(cx, cy, r, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    out[size] = ctx.getImageData(0, 0, size, size);
  }
  return out;
}

function commandFor(tabId) {
  const shortId = shortIds.get(tabIds.get(tabId));
  return shortId ? `${cliNames()[0] || 'cockpit'} browser ${shortId}` : null;
}

async function updateBadge(tab) {
  if (!tab?.id) return;
  const tabId = tab.id;
  if (!isAddressable(tab)) {
    chrome.action.setBadgeText({ tabId, text: '' }).catch(() => {});
    chrome.action.setIcon({ tabId, path: ICON_PATHS }).catch(() => {});
    chrome.action.setTitle({ tabId, title: 'OpenCockpit Bridge' }).catch(() => {});
    return;
  }
  const pending = pendingApprovals.has(tabId);
  const allowed = isAllowed(tab);
  const driving = debuggingTabs().find((d) => d.tabId === tabId);
  // Only "?" (asking) uses the badge; the controlled state is a green dot
  // drawn into the icon, and the grey icon says "not allowed". The short id
  // lives in the tooltip and the popup.
  chrome.action.setBadgeText({ tabId, text: pending ? '?' : '' }).catch(() => {});
  chrome.action.setBadgeBackgroundColor({ tabId, color: '#f59e0b' }).catch(() => {});
  chrome.action.setBadgeTextColor?.({ tabId, color: '#ffffff' })?.catch?.(() => {});
  if (pending) {
    chrome.action.setIcon({ tabId, path: ICON_PATHS }).catch(() => {});
  } else {
    (driving ? drivingIconSet() : allowed ? linkedIconSet() : grayIconSet())
      .then((imageData) => chrome.action.setIcon({ tabId, imageData }))
      .catch(() => {});
  }
  const cmd = commandFor(tabId);
  const head = pending ? 'OpenCockpit is asking to control this tab — click to answer'
    : driving ? `OpenCockpit is driving this tab now${driving.reasons.length ? ` (${driving.reasons.join(', ')})` : ''}`
      : allowed ? '✅ OpenCockpit may control this tab' : 'OpenCockpit will ask before controlling this tab';
  chrome.action.setTitle({ tabId, title: [head, cmd].filter(Boolean).join('\n') }).catch(() => {});
}

async function updateAllBadges() {
  for (const tab of await chrome.tabs.query({})) updateBadge(tab);
}

// Grants changed from the popup (storage.session `popupRequest`).
async function applyPopupRequest({ op, tabId }) {
  await ready;
  logApproval('popup-request', { op, tabId });
  if (typeof tabId !== 'number') return;
  if (op === 'show-tab') {
    const t = await chrome.tabs.update(tabId, { active: true }).catch(() => null);
    if (t) await chrome.windows.update(t.windowId, { focused: true, drawAttention: true }).catch(() => {});
    return;
  }
  if (op === 'detach-tab') {
    // Let go now: capture and any emulation end with the session.
    await detach(tabId);
    return;
  }
  if (op === 'allow-tab') grantTab(tabId);
  else if (op === 'revoke-tab') await revokeTab(tabId);
  else return;
  await updateAllBadges();
  broadcastTabs();
}

// ── Approval prompt ───────────────────────────────────────────────────────

/** chromeTabId → { host, title, requestId, waiters, expireTimer } */
const pendingApprovals = new Map();

/**
 * Show the approval prompt on the tab's own window: focus the window, make the
 * tab active, open the toolbar popup there. Chrome refuses all of that while
 * the browser is not the frontmost app (the user is in a terminal), so on
 * failure the native host brings the browser forward and the focus listener
 * below finishes the job.
 */
let popupOwed = null; // { tabId, windowId } while a prompt could not be shown
async function showApproval(tabId, windowId) {
  await chrome.windows.update(windowId, { focused: true }).catch(() => {});
  await chrome.tabs.update(tabId, { active: true }).catch(() => {});
  try {
    await chrome.action.openPopup({ windowId });
    popupOwed = null;
    logApproval('popup-opened', { windowId });
  } catch (e) {
    const firstMiss = !popupOwed;
    popupOwed = { tabId, windowId };
    logApproval('popup-failed', { windowId, error: e.message });
    if (firstMiss && nativePort) {
      nativePort.postMessage({ type: 'activate-browser' });
      logApproval('activate-requested');
    }
  }
}

chrome.windows.onFocusChanged.addListener((windowId) => {
  if (!popupOwed || windowId === chrome.windows.WINDOW_ID_NONE) return;
  if (!pendingApprovals.has(popupOwed.tabId)) { popupOwed = null; return; }
  logApproval('focus-regained', { windowId });
  showApproval(popupOwed.tabId, popupOwed.windowId);
});

/** Recent approval events, for `cockpit browser <id> debug_state`. */
const approvalLog = [];
function logApproval(event, detail = {}) {
  approvalLog.push({ t: new Date().toISOString(), event, ...detail });
  if (approvalLog.length > 30) approvalLog.shift();
}

function publishApprovalRequests() {
  const approvalRequests = {};
  for (const [tabId, p] of pendingApprovals) {
    approvalRequests[tabId] = { requestId: p.requestId, host: p.host, title: p.title };
  }
  return chrome.storage.session.set({ approvalRequests }).catch(() => {});
}

function settleApproval(tabId, decision) {
  const p = pendingApprovals.get(tabId);
  if (!p) return;
  logApproval('settled', { tabId, decision });
  clearTimeout(p.expireTimer);
  pendingApprovals.delete(tabId);
  publishApprovalRequests();
  if (decision === 'allow') grantTab(tabId);
  for (const w of p.waiters) w(decision);
  chrome.tabs.get(tabId).then(updateBadge).catch(() => {});
  if (decision === 'allow') broadcastTabs();
}

class ApprovalError extends Error {
  constructor(message, code) { super(message); this.code = code; }
}

async function requireApproval(tab, waitMs) {
  if (isAllowed(tab)) return;
  const host = (() => { try { return new URL(tab.url).host || 'local file'; } catch { return 'this tab'; } })();
  let p = pendingApprovals.get(tab.id);
  if (!p) {
    p = { host, title: tab.title || tabUrl(tab), requestId: `cockpit-approve-${tab.id}-${Date.now()}`, waiters: [] };
    pendingApprovals.set(tab.id, p);
    // An unanswered request lapses (no grant) so the "?" does not linger forever.
    p.expireTimer = setTimeout(() => settleApproval(tab.id, 'expired'), 5 * 60_000);
    await publishApprovalRequests();
    logApproval('request', { tabId: tab.id, requestId: p.requestId, host });
  } else {
    logApproval('request-again', { tabId: tab.id, requestId: p.requestId });
  }
  // Every command that waits re-surfaces the prompt on the tab itself.
  updateBadge(tab);
  await showApproval(tab.id, tab.windowId);
  const decision = await new Promise((resolve) => {
    p.waiters.push(resolve);
    setTimeout(() => resolve('timeout'), Math.max(3000, waitMs));
  });
  if (decision === 'allow') return;
  if (decision === 'deny') {
    throw new ApprovalError(`The user declined control of this tab (${host}).`, 'USER_DENIED');
  }
  throw new ApprovalError(
    `Waiting for the user to allow control of this tab (${host}).\n` +
    `  The browser was brought to the front on that tab, asking in the OpenCockpit popup (its icon shows "?").\n` +
    `  Ask the user to approve it, then re-run this command.`,
    'NEEDS_APPROVAL',
  );
}

// Answers and grant changes from popup.html arrive through session storage (no message channel).
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== 'session') return;
  if (changes.popupRequest?.newValue) applyPopupRequest(changes.popupRequest.newValue);
  const d = changes.approvalDecision?.newValue;
  if (!d) return;
  const p = pendingApprovals.get(d.tabId);
  logApproval('popup-answer', { tabId: d.tabId, decision: d.decision, matched: !!p && p.requestId === d.requestId });
  if (!p || p.requestId !== d.requestId) return;
  if (d.decision === 'allow' || d.decision === 'deny') settleApproval(d.tabId, d.decision);
});

function refreshActionTitle() {
  const n = instances.size;
  const title = !nativeStatus.connected
    ? `OpenCockpit Bridge — native host not connected (${nativeStatus.error || 'starting'}). Start cockpit once to install it.`
    : n === 0
      ? 'OpenCockpit Bridge — no Cockpit server running'
      : `OpenCockpit Bridge (${n} server${n > 1 ? 's' : ''} connected)`;
  chrome.action.setTitle({ title }).catch(() => {});
}

async function groupIntoCockpit(tab) {
  try {
    const groups = await chrome.tabGroups.query({ windowId: tab.windowId, title: GROUP_TITLE });
    if (groups.length) {
      await chrome.tabs.group({ tabIds: [tab.id], groupId: groups[0].id });
    } else {
      const groupId = await chrome.tabs.group({ tabIds: [tab.id], createProperties: { windowId: tab.windowId } });
      await chrome.tabGroups.update(groupId, { title: GROUP_TITLE, color: 'blue', collapsed: false });
    }
  } catch (e) {
    console.warn(LOG, 'tab grouping failed:', e.message);
  }
}

// ============================================================================
// Bubble targets
// ============================================================================

/** `${instanceId}:${bubbleId}` → { tabId, frameId, windowId } */
const bubbleCache = new Map();

function originOf(url) {
  try { return new URL(url).origin; } catch { return null; }
}

async function frameName(tabId, frameId) {
  try {
    const [res] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [frameId] },
      func: () => window.name,
    });
    return res?.result ?? null;
  } catch {
    return null;
  }
}

/** Why the last lookup per bubble failed — surfaced in the TARGET_NOT_FOUND message. */
const bubbleMissDiag = new Map();

async function findBubbleFrame(inst, bubbleId) {
  const name = `cockpit-bubble-${bubbleId}`;
  const diag = { cockpitTabs: [], origins: [...inst.origins] };
  const key = `${inst.id}:${bubbleId}`;
  const cached = bubbleCache.get(key);
  if (cached && await frameName(cached.tabId, cached.frameId) === name) return cached;
  bubbleCache.delete(key);

  const tabs = await chrome.tabs.query({});
  for (const tab of tabs) {
    if (!tab.id || !inst.origins.has(originOf(tab.url || ''))) continue;
    const frames = await chrome.webNavigation.getAllFrames({ tabId: tab.id }).catch(() => null) || [];
    const byId = new Map(frames.map(f => [f.frameId, f]));
    const candidates = frames.filter(f =>
      f.frameId !== 0 &&
      byId.has(f.parentFrameId) &&
      inst.origins.has(originOf(byId.get(f.parentFrameId).url))
    );
    const names = await Promise.all(candidates.map(f => frameName(tab.id, f.frameId)));
    diag.cockpitTabs.push({
      url: tab.url,
      frames: frames.length,
      candidates: candidates.map((f, i) => ({ frameId: f.frameId, url: String(f.url).slice(0, 120), name: names[i] })),
    });
    const idx = names.indexOf(name);
    if (idx >= 0) {
      const found = { tabId: tab.id, frameId: candidates[idx].frameId, windowId: tab.windowId };
      bubbleCache.set(key, found);
      bubbleMissDiag.delete(key);
      return found;
    }
  }
  bubbleMissDiag.set(key, diag);
  return null;
}

async function bubbleSubtreeFrameIds(tabId, rootFrameId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId }).catch(() => null) || [];
  const ids = new Set([rootFrameId]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const f of frames) {
      if (!ids.has(f.frameId) && ids.has(f.parentFrameId)) { ids.add(f.frameId); grew = true; }
    }
  }
  return [...ids];
}

// ============================================================================
// Server messages
// ============================================================================

class TargetNotFound extends Error {
  constructor(message) { super(message); this.code = 'TARGET_NOT_FOUND'; }
}

async function handleServerMessage(inst, msg) {
  await ready;
  const reply = (payload) => sendToInstance(inst.id, { type: 'result', reqId: msg.reqId, ...payload });
  const run = async (fn) => {
    try {
      reply({ ok: true, data: await fn() });
    } catch (e) {
      reply({ ok: false, error: e?.message || String(e), code: e?.code });
    }
  };

  switch (msg.type) {
    case 'cmd':
      // Leave a little of the caller's timeout for the reply to travel back.
      return run(() => runCommand(inst, msg.target || {}, msg.action, msg.params || {},
        (Number(msg.timeout) || 15000) - 2000));
    case 'open-tab':
      return run(() => openTab(inst, msg));
    case 'close-tab':
      return run(() => closeTab(inst, msg.fullId));
    case 'tabs-request':
      return sendTabsTo(inst.id);
    case 'instance-info':
      if (typeof msg.cli === 'string') inst.cli = msg.cli;
      setInstanceCli(inst.id, msg.cli);
      return;
    case 'tab-ids':
      setInstanceCli(inst.id, msg.cli);
      return applyTabIds(msg.ids || {}, msg.reroll || []);
    case 'reload':
      reply({ ok: true, data: { reloading: true } });
      setTimeout(() => chrome.runtime.reload(), 100);
      return;
    case 'ping':
      return reply({ ok: true, data: { pong: Date.now() } });
    default:
      return reply({ ok: false, error: `Unknown message type "${msg.type}"` });
  }
}

async function openTab(inst, { fullId, url, projectCwd, show }) {
  if (!fullId || !url) throw new Error('open-tab requires fullId and url');
  const tab = await chrome.tabs.create({ url, active: !!show });
  // A tab Cockpit opened is Cockpit's to drive.
  tabIds.set(tab.id, fullId);
  tabUrls.set(tab.id, url);
  openedTabs.set(tab.id, { projectCwd });
  grantTab(tab.id);
  await groupIntoCockpit(tab);
  if (show) {
    // The user is looking at Cockpit — possibly in another app or browser —
    // so bring this tab's window forward and ask the native host to raise the
    // browser itself (an extension alone cannot on macOS).
    await chrome.windows.update(tab.windowId, { focused: true }).catch(() => {});
    if (nativePort) nativePort.postMessage({ type: 'activate-browser' });
    // Fallback if the browser cannot be raised (Wayland, locked-down Windows):
    // flash the taskbar / dock entry. Cleared automatically once focused.
    chrome.windows.update(tab.windowId, { drawAttention: true }).catch(() => {});
  }
  broadcastTabs();
  return { chromeTabId: tab.id, url };
}

async function closeTab(inst, fullId) {
  const tabId = findTabByFullId(fullId);
  if (tabId == null) throw new TargetNotFound(`Tab "${fullId}" no longer exists`);
  if (!openedTabs.has(tabId)) {
    throw new Error('Cockpit only closes tabs it opened. This tab belongs to the user — leave it open.');
  }
  await chrome.tabs.remove(tabId);
  return { closed: true };
}

// ============================================================================
// Command execution
// ============================================================================

async function resolveTarget(inst, target) {
  if (target.kind === 'bubble') {
    const frame = await findBubbleFrame(inst, String(target.bubbleId || ''));
    if (!frame) {
      const diag = bubbleMissDiag.get(`${inst.id}:${target.bubbleId}`);
      const seen = !diag || !diag.cockpitTabs.length
        ? `  No tab in this browser shows ${diag ? diag.origins[0] : 'this Cockpit'}.`
        : diag.cockpitTabs.map(t =>
          `  Cockpit tab ${t.url} (${t.frames} frames) — candidate frames:\n` +
          (t.candidates.length
            ? t.candidates.map(c => `    #${c.frameId} name=${JSON.stringify(c.name)} url=${c.url}`).join('\n')
            : '    (none)')
        ).join('\n');
      throw new TargetNotFound(
        `Bubble frame "cockpit-bubble-${target.bubbleId}" not found in this browser.\n${seen}`
      );
    }
    return { kind: 'bubble', ...frame };
  }
  if (target.kind === 'tab') {
    const tabId = findTabByFullId(String(target.fullId || ''));
    const tab = tabId == null ? null : await chrome.tabs.get(tabId).catch(() => null);
    if (!tab) throw new TargetNotFound(`Tab "${target.fullId}" no longer exists (closed, or the browser restarted)`);
    if (!isAddressable(tab)) throw new TargetNotFound(`Tab "${target.fullId}" is now on a page Cockpit cannot control`);
    return { kind: 'tab', tabId: tab.id, frameId: 0, windowId: tab.windowId, tab };
  }
  throw new Error(`Unknown target kind "${target.kind}"`);
}

const NAVIGATING_ACTIONS = new Set(['navigate', 'reload', 'back', 'forward']);

const SITE_ACCESS_HINT =
  'OpenCockpit Bridge needs access to all sites, and Chrome currently withholds it.\n' +
  '  Fix: click the OpenCockpit icon → "Grant access to all sites",\n' +
  '  or chrome://extensions → OpenCockpit Bridge → Details → Site access → "On all sites".';

/**
 * The manifest asks for `<all_urls>`, but Chrome lets users withhold it (Site
 * access: "On click" / "On specific sites"); injections then stall instead of
 * failing. Like Codex, Cockpit requires "On all sites" and checks up front;
 * which tabs it may act on is decided by its own per-tab grants.
 */
async function hasSiteAccess() {
  return chrome.permissions.contains({ origins: ['<all_urls>'] }).catch(() => false);
}

async function publishSiteAccess() {
  chrome.storage.session.set({ siteAccessAll: await hasSiteAccess() }).catch(() => {});
}
publishSiteAccess();
chrome.permissions.onAdded.addListener(publishSiteAccess);
chrome.permissions.onRemoved.addListener(publishSiteAccess);

tools.initTabTools({ runCore });

// The popup, the toolbar icon and `cockpit browser tabs` all show which tabs
// the debugger is on — Chrome's own bar says only "debugging this browser".
onSessionsChanged(async () => {
  chrome.storage.session.set({ debugTabs: debuggingTabs() }).catch(() => {});
  await updateAllBadges();
  broadcastTabs();
});

async function runCore(tabId, frameId, action, params) {
  const target = { tabId, frameIds: [frameId] };
  try {
    await withTimeout(chrome.scripting.executeScript({ target, files: ['page-core.js'] }), 10_000,
      'Injecting into the page timed out after 10s (Chrome did not run the script)');
  } catch (e) {
    throw new Error(`Cannot run in this page (${e.message}). Chrome blocks extensions on chrome:// pages, the Web Store and other extensions' pages.`);
  }
  // These unload the document they run in; losing the reply is the expected outcome.
  const navigates = NAVIGATING_ACTIONS.has(action) || (action === 'reset' && params.reload);
  let res;
  try {
    [res] = await chrome.scripting.executeScript({
      target,
      func: async (a, p) => {
        try {
          return { ok: true, data: await globalThis.__cockpitCore.run(a, p) };
        } catch (e) {
          return { ok: false, error: (e && e.message) || String(e) };
        }
      },
      args: [action, params],
    });
  } catch (e) {
    if (navigates) return { navigating: true };
    throw e;
  }
  const result = res?.result;
  if (!result) {
    if (navigates) return { navigating: true };
    throw new Error('The page navigated or closed before the command finished');
  }
  if (!result.ok) throw new Error(result.error);
  return result.data;
}

/** Tab actions that only reveal what `cockpit browser tabs` already lists, or just focus the tab. */
const NO_APPROVAL_ACTIONS = new Set(['url', 'title', 'show', 'release', 'debug_state']);

async function runCommand(inst, rawTarget, action, params, waitMs) {
  const t = await resolveTarget(inst, rawTarget);
  if (action === 'release') {
    // Hand control back: the tab goes grey and the next command asks again.
    if (t.kind !== 'tab') throw new Error('release applies to tabs only — close a bubble instead');
    const was = grantedTabs.has(t.tabId);
    await revokeTab(t.tabId);
    updateBadge(t.tab);
    broadcastTabs();
    return { released: was };
  }
  if (!['release', 'debug_state', 'show', 'url', 'title'].includes(action) && !(await hasSiteAccess())) {
    throw new Error(SITE_ACCESS_HINT);
  }
  // A tab's URL and title are already public via `cockpit browser tabs`; read
  // them from Chrome rather than entering a page that may not be allowed.
  if (t.kind === 'tab' && (action === 'url' || action === 'title')) {
    return action === 'url' ? tabUrl(t.tab) : (t.tab.title || '');
  }
  if (t.kind === 'tab' && !NO_APPROVAL_ACTIONS.has(action)) {
    await requireApproval(t.tab, waitMs);
  }
  if (action === 'debug_state') {
    const tabNow = t.kind === 'tab' ? await chrome.tabs.get(t.tabId).catch(() => null) : null;
    const win = tabNow ? await chrome.windows.get(tabNow.windowId).catch(() => null) : null;
    const lastFocused = await chrome.windows.getLastFocused().catch(() => null);
    return {
      version: VERSION,
      tabState: tabNow ? { active: tabNow.active, discarded: tabNow.discarded, frozen: tabNow.frozen, status: tabNow.status, windowId: tabNow.windowId } : null,
      window: win ? { id: win.id, state: win.state, focused: win.focused, type: win.type } : null,
      lastFocusedWindow: lastFocused ? { id: lastFocused.id, state: lastFocused.state, focused: lastFocused.focused } : null,
      windowCount: (await chrome.windows.getAll()).length,
      tab: t.kind === 'tab' ? { chromeTabId: t.tabId, granted: grantedTabs.has(t.tabId), pending: pendingApprovals.has(t.tabId) } : null,
      pending: [...pendingApprovals].map(([tabId, p]) => ({ tabId, requestId: p.requestId, host: p.host, waiters: p.waiters.length })),
      grantedTabs: [...grantedTabs],
      log: approvalLog,
    };
  }

  if (t.kind === 'tab') return runTabCommand(t, action, params);

  switch (action) {
    case 'screenshot':
      if (params.full || params.ref || params.selector) throw new Error('screenshot --full / of one element applies to tabs; a bubble is captured as shown');
      return screenshot(t, params);
    case 'evaluate':
      return evaluate(t, params);
    case 'evaluate_chunk':
      return { error: 'evaluate results are no longer chunked; re-run evaluate' };
    case 'viewport':
    case 'emulate':
    case 'dialog':
    case 'upload':
    case 'drag':
    case 'coverage':
      throw new Error(`${action} applies to tabs only — a bubble is sized and run by the Cockpit console`);
  }
  return runCore(t.tabId, t.frameId, action, params);
}

/** Actions that answer or reconfigure the tab rather than act in its page. */
const DIALOG_SAFE_ACTIONS = new Set(['dialog', 'viewport', 'emulate', 'theme', 'show', 'screenshot', 'coverage']);

async function runTabCommand(t, action, params) {
  const known = sessions.get(t.tabId)?.dialog;
  if (known && !DIALOG_SAFE_ACTIONS.has(action)) throw tools.dialogError(known);
  const useDom = params.dom === true;
  delete params.dom;

  switch (action) {
    case 'navigate':
      if (!params.url) throw new Error('navigate requires --url');
      await chrome.tabs.update(t.tabId, { url: params.url });
      return { navigated: params.url };
    case 'show':
      await chrome.tabs.update(t.tabId, { active: true });
      await chrome.windows.update(t.windowId, { focused: true });
      return { shown: true };
    case 'screenshot':
      if (params.full || params.ref || params.selector || params.text) return tools.screenshotTab(t, params);
      return screenshot(t, params);
    case 'evaluate':
      return tools.watchDialogs(t.tabId, evaluate({ ...t, frameId: tools.targetFrame(params) }, params));
    case 'evaluate_chunk':
      return { error: 'evaluate results are no longer chunked; re-run evaluate' };
    case 'click':
    case 'type':
    case 'key':
    case 'hover':
    case 'scroll':
      if (!useDom) return tools.trustedInput(t, action, params);
      break;
    case 'drag': return tools.dragCommand(t, params);
    case 'upload': return tools.uploadCommand(t, params);
    case 'dialog': return tools.dialogCommand(t, params);
    case 'viewport': return tools.viewportCommand(t, params);
    case 'emulate': return tools.emulateCommand(t, params);
    case 'coverage': return tools.coverageCommand(t, params);
    case 'theme':
      if (!useDom) return tools.themeCommand(t, params);
      break;
    case 'events':
      if (!useDom) return tools.eventsCommand(t, params);
      break;
    case 'perf':
      if (params.metric === 'runtime') return tools.runtimeMetrics(t);
      break;
    case 'snapshot':
      return tools.watchDialogs(t.tabId, tools.snapshotTab(t, params));
    case 'console':
    case 'network':
    case 'network_record':
      return captureCommand(t, action, params);
    case 'network_detail':
      return networkDetail(t, params);
    case 'wait':
      if (params.networkIdle) return waitNetworkIdle(t, params);
      break;
  }
  const frameId = tools.targetFrame(params);
  const s = sessions.get(t.tabId);
  params.__capture = s?.capture ? captureSnapshot(s.capture) : null;
  return tools.watchDialogs(t.tabId, runCore(t.tabId, frameId, action, params));
}

// ── Screenshot ──────────────────────────────────────────────────────────

async function screenshot(t, params) {
  if (t.kind === 'bubble') {
    const b = params.bounds;
    if (!b || !b.width || !b.height) throw new Error('screenshot of a bubble needs bounds from the Cockpit UI');
    const [prev] = await chrome.tabs.query({ active: true, windowId: t.windowId });
    if (prev?.id !== t.tabId) await chrome.tabs.update(t.tabId, { active: true });
    try {
      await new Promise(r => setTimeout(r, prev?.id !== t.tabId ? 250 : 0));
      const full = await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' });
      return { image: await cropDataUrl(full, b), format: 'png' };
    } finally {
      if (prev?.id && prev.id !== t.tabId) chrome.tabs.update(prev.id, { active: true }).catch(() => {});
    }
  }
  // Tab: the visible one can be captured without the debugger — unless a
  // viewport is emulated, where only CDP captures the emulated page itself.
  if (t.tab.active && !hasOverrides(sessions.get(t.tabId))) {
    const win = await chrome.windows.get(t.windowId).catch(() => null);
    if (win && win.state !== 'minimized') {
      return { image: await chrome.tabs.captureVisibleTab(t.windowId, { format: 'png' }), format: 'png' };
    }
  }
  const res = await withTimeout(cdp(t.tabId, 'Page.captureScreenshot', { format: 'png' }), 10_000,
    'Background-tab screenshot timed out; open the tab (cockpit browser <id> show) and retry');
  return { image: `data:image/png;base64,${res.data}`, format: 'png' };
}

async function cropDataUrl(dataUrl, b) {
  const blob = await (await fetch(dataUrl)).blob();
  const bmp = await createImageBitmap(blob);
  const x = Math.max(0, Math.min(b.x, bmp.width));
  const y = Math.max(0, Math.min(b.y, bmp.height));
  const w = Math.max(1, Math.min(b.width, bmp.width - x));
  const h = Math.max(1, Math.min(b.height, bmp.height - y));
  const canvas = new OffscreenCanvas(w, h);
  canvas.getContext('2d').drawImage(bmp, x, y, w, h, 0, 0, w, h);
  const out = await canvas.convertToBlob({ type: 'image/png' });
  const bytes = new Uint8Array(await out.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:image/png;base64,${btoa(bin)}`;
}

// ── Evaluate ────────────────────────────────────────────────────────────

/** Runs in the page's MAIN world. Mirrors CDP replMode closely enough. */
async function mainWorldEval(code) {
  try {
    const result = (0, eval)(code);
    return { ok: true, data: result instanceof Promise ? await result : result };
  } catch (e1) {
    if (e1 instanceof EvalError || /unsafe-eval|Content Security Policy/i.test(String(e1 && e1.message))) {
      return { ok: false, csp: true, error: String(e1 && e1.message) };
    }
    try {
      const AF = Object.getPrototypeOf(async function () {}).constructor;
      return { ok: true, data: await new AF(code)() };
    } catch {
      return { ok: false, error: (e1 && e1.message) || String(e1) };
    }
  }
}

async function evaluate(t, { js, allFrames }) {
  if (typeof js !== 'string' || !js) throw new Error('evaluate requires --js');
  const frameIds = allFrames
    ? (t.kind === 'bubble' ? await bubbleSubtreeFrameIds(t.tabId, t.frameId) : null)
    : [t.frameId];
  const target = frameIds ? { tabId: t.tabId, frameIds } : { tabId: t.tabId, allFrames: true };
  const results = await chrome.scripting.executeScript({ target, world: 'MAIN', func: mainWorldEval, args: [js] });

  if (allFrames) {
    const all = (results || [])
      .map(r => ({ frameId: r.frameId, ...(r.result || {}) }))
      .filter(r => r.ok && r.data !== undefined)
      .map(r => ({ frameId: r.frameId, data: r.data }));
    return all.length === 1 ? all[0].data : all;
  }

  const r = results?.[0]?.result;
  if (r?.ok) return r.data;
  if (r?.csp) return cdpEvaluate(t, js);
  throw new Error(r?.error || 'Execution failed');
}

/** CSP blocked eval in the page — fall back to CDP, which is not bound by page CSP. */
async function cdpEvaluate(t, js) {
  let contextId;
  if (t.kind === 'bubble') {
    contextId = await mainWorldContextForBubble(t);
  }
  const res = await cdp(t.tabId, 'Runtime.evaluate', {
    expression: js,
    contextId,
    awaitPromise: true,
    returnByValue: true,
    replMode: true,
    userGesture: true,
  });
  if (res.exceptionDetails) {
    throw new Error(res.exceptionDetails.exception?.description || res.exceptionDetails.text || 'Evaluation failed');
  }
  return res.result?.value;
}

async function mainWorldContextForBubble(t) {
  const name = await frameName(t.tabId, t.frameId);
  const { frameTree } = await cdp(t.tabId, 'Page.getFrameTree');
  const stack = [frameTree];
  let cdpFrameId = null;
  while (stack.length) {
    const node = stack.pop();
    if (node.frame.name === name) { cdpFrameId = node.frame.id; break; }
    for (const child of node.childFrames || []) stack.push(child);
  }
  if (!cdpFrameId) throw new Error('Bubble frame not found over CDP');
  const contexts = [];
  const onEvent = (source, method, params) => {
    if (source.tabId === t.tabId && method === 'Runtime.executionContextCreated') contexts.push(params.context);
  };
  chrome.debugger.onEvent.addListener(onEvent);
  try {
    const s = sessions.get(t.tabId);
    await cdp(t.tabId, 'Runtime.enable');
    if (!s?.capture) await cdp(t.tabId, 'Runtime.disable');
  } finally {
    chrome.debugger.onEvent.removeListener(onEvent);
  }
  const ctx = contexts.find(c => c.auxData?.frameId === cdpFrameId && c.auxData?.isDefault);
  if (!ctx) throw new Error('No main-world context for the bubble frame');
  return ctx.id;
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ============================================================================
// Console / network capture on tabs (CDP)
// ============================================================================

function newCapture() {
  return {
    console: [],
    network: [],
    byRequestId: new Map(),
    nextId: 0,
    recording: { active: false, filters: {}, startedAt: 0, timer: null },
    ttlTimer: null,
    startedAt: Date.now(),
  };
}

async function ensureCapture(t) {
  const s = await attach(t.tabId);
  let started = false;
  if (!s.capture) {
    s.capture = newCapture();
    started = true;
    clearTimeout(s.idleTimer);
    await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Runtime.enable');
    await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Log.enable');
    await chrome.debugger.sendCommand({ tabId: t.tabId }, 'Network.enable', { maxPostDataSize: MAX_BODY_SIZE });
  }
  keepCapture(t.tabId);
  return { capture: s.capture, started };
}

/** Push back the end of capture: every read of it counts as use. */
function keepCapture(tabId) {
  const cap = sessions.get(tabId)?.capture;
  if (!cap) return;
  // A recording runs to its own end (network_record --ttl), then idles out.
  const ms = cap.recording.active
    ? Math.max(CAPTURE_IDLE_MS, (cap.recording.endsAt || 0) - Date.now() + CAPTURE_IDLE_MS)
    : CAPTURE_IDLE_MS;
  clearTimeout(cap.ttlTimer);
  cap.until = Date.now() + ms;
  cap.ttlTimer = setTimeout(() => stopCapture(tabId), ms);
  notifySessions();
}

async function stopCapture(tabId) {
  const s = sessions.get(tabId);
  if (!s?.capture) return;
  clearTimeout(s.capture.ttlTimer);
  s.capture = null;
  if (s.attached) {
    // Network emulation / URL blocking ride on the Network domain too.
    const keepNetwork = s.overrides.network || s.overrides.block;
    for (const m of [...(keepNetwork ? [] : ['Network.disable']), 'Log.disable', 'Runtime.disable']) {
      await chrome.debugger.sendCommand({ tabId }, m).catch(() => {});
    }
  }
  touch(tabId);
}

function pushBounded(arr, item) {
  arr.push(item);
  if (arr.length > MAX_CAPTURE_ENTRIES) arr.splice(0, arr.length - MAX_CAPTURE_ENTRIES);
}

function remoteToText(o) {
  if (!o) return '';
  if (o.type === 'string') return o.value;
  if ('value' in o) {
    try { return typeof o.value === 'string' ? o.value : JSON.stringify(o.value); } catch { return String(o.value); }
  }
  if (o.unserializableValue) return o.unserializableValue;
  return o.description || o.type;
}

function shouldRecord(rec, method, url, status) {
  if (!rec.active) return false;
  const f = rec.filters || {};
  if (f.method && String(method).toUpperCase() !== String(f.method).toUpperCase()) return false;
  if (f.url) {
    const pattern = String(f.url).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
    if (!new RegExp(pattern, 'i').test(url)) return false;
  }
  if (f.status && status != null) {
    const ranges = String(f.status).split(',').map(s => s.trim());
    const ok = ranges.some(range => range.endsWith('xx')
      ? status >= Number(range[0]) * 100 && status < Number(range[0]) * 100 + 100
      : status === Number(range));
    if (!ok) return false;
  }
  return true;
}

function lowerHeaders(h) {
  const out = {};
  for (const [k, v] of Object.entries(h || {})) out[k.toLowerCase()] = v;
  return out;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const cap = sessions.get(source.tabId)?.capture;
  if (!cap) return;
  const now = Date.now();
  switch (method) {
    case 'Runtime.consoleAPICalled': {
      const level = params.type === 'warning' ? 'warn' : params.type;
      if (!['log', 'info', 'warn', 'error', 'debug'].includes(level)) return;
      pushBounded(cap.console, { level, text: (params.args || []).map(remoteToText).join(' '), timestamp: now });
      return;
    }
    case 'Runtime.exceptionThrown': {
      const d = params.exceptionDetails || {};
      pushBounded(cap.console, { level: 'error', text: d.exception?.description || d.text || 'Uncaught exception', timestamp: now });
      return;
    }
    case 'Log.entryAdded': {
      const e = params.entry || {};
      const level = e.level === 'warning' ? 'warn' : e.level === 'verbose' ? 'debug' : e.level;
      pushBounded(cap.console, { level, text: e.url ? `${e.text} (${e.url})` : e.text, timestamp: now });
      return;
    }
    case 'Network.requestWillBeSent': {
      const req = params.request || {};
      const existing = cap.byRequestId.get(params.requestId);
      if (existing && params.redirectResponse) {
        existing.status = params.redirectResponse.status;
        existing.duration = now - existing.startTime;
      }
      const recorded = shouldRecord(cap.recording, req.method, req.url, null);
      const entry = {
        id: ++cap.nextId, method: req.method, url: req.url,
        type: String(params.type || 'other').toLowerCase(),
        startTime: now, status: null, duration: null,
        requestHeaders: recorded ? lowerHeaders(req.headers) : null,
        requestBody: recorded && typeof req.postData === 'string' ? req.postData.slice(0, MAX_BODY_SIZE) : null,
        responseHeaders: null, responseBody: null, responseSize: null,
        recorded,
        _rawRequestHeaders: req.headers,
      };
      cap.byRequestId.set(params.requestId, entry);
      pushBounded(cap.network, entry);
      return;
    }
    case 'Network.responseReceived': {
      const entry = cap.byRequestId.get(params.requestId);
      if (!entry) return;
      const res = params.response || {};
      entry.status = res.status;
      entry._mime = res.mimeType || '';
      if (entry.recorded || shouldRecord(cap.recording, entry.method, entry.url, res.status)) {
        entry.recorded = true;
        entry.requestHeaders = entry.requestHeaders || lowerHeaders(entry._rawRequestHeaders);
        entry.responseHeaders = lowerHeaders(res.headers);
      }
      return;
    }
    case 'Network.loadingFinished': {
      const entry = cap.byRequestId.get(params.requestId);
      if (!entry) return;
      entry.duration = now - entry.startTime;
      entry.responseSize = params.encodedDataLength;
      if (entry.recorded && /json|text|xml|html|javascript/.test(entry._mime || '')) {
        chrome.debugger.sendCommand({ tabId: source.tabId }, 'Network.getResponseBody', { requestId: params.requestId })
          .then((r) => {
            const body = r.base64Encoded ? null : r.body;
            entry.responseBody = body && body.length > MAX_BODY_SIZE ? { truncated: true, size: body.length } : body;
          })
          .catch(() => {});
      }
      cap.byRequestId.delete(params.requestId);
      return;
    }
    case 'Network.loadingFailed': {
      const entry = cap.byRequestId.get(params.requestId);
      if (!entry) return;
      entry.status = entry.status ?? 0;
      entry.duration = now - entry.startTime;
      entry.error = params.errorText;
      cap.byRequestId.delete(params.requestId);
      return;
    }
  }
});

function captureSnapshot(cap) {
  return {
    console: cap.console,
    network: cap.network.map(e => ({
      id: e.id, method: e.method, url: e.url, type: e.type, startTime: e.startTime,
      status: e.status, duration: e.duration, responseSize: e.responseSize, recorded: e.recorded,
    })),
  };
}

const CAPTURE_NOTE =
  'Capture started on this tab just now — earlier activity is not available. ' +
  'Reload the page to capture the initial load. Capture stops 2 minutes after the last read (Chrome shows its debugging bar until then).';

async function captureCommand(t, action, params) {
  const { capture: cap, started } = await ensureCapture(t);

  if (action === 'network_record') {
    const sub = params.action || 'status';
    const rec = cap.recording;
    if (sub === 'start') {
      clearTimeout(rec.timer);
      rec.active = true;
      rec.filters = {};
      if (params.url) rec.filters.url = params.url;
      if (params.method) rec.filters.method = params.method;
      if (params.status) rec.filters.status = params.status;
      rec.startedAt = Date.now();
      const ttl = Number(params.ttl) || 600;
      rec.endsAt = Date.now() + ttl * 1000;
      keepCapture(t.tabId);
      rec.timer = setTimeout(() => {
        rec.active = false;
        for (const e of cap.network) { e.requestHeaders = e.requestBody = e.responseHeaders = e.responseBody = null; }
        keepCapture(t.tabId);
      }, ttl * 1000);
      return { recording: true, filters: rec.filters, expiresIn: `${ttl}s`, ...(started ? { note: CAPTURE_NOTE } : {}) };
    }
    if (sub === 'stop') {
      rec.active = false;
      clearTimeout(rec.timer);
      const recordedCount = cap.network.filter(r => r.recorded).length;
      await stopCapture(t.tabId);
      return { recording: false, recordedCount };
    }
    return {
      recording: rec.active,
      filters: rec.filters,
      startedAt: rec.startedAt || null,
      elapsed: rec.startedAt ? `${Math.round((Date.now() - rec.startedAt) / 1000)}s` : null,
      recordedCount: cap.network.filter(r => r.recorded).length,
      totalCount: cap.network.length,
    };
  }

  if (params.clear) {
    if (action === 'console') cap.console.length = 0;
    else { cap.network.length = 0; cap.byRequestId.clear(); }
    return { cleared: true };
  }

  const data = await runCore(t.tabId, 0, action, { ...params, __capture: captureSnapshot(cap) });
  return started ? { captureStarted: true, note: CAPTURE_NOTE, entries: data } : data;
}

function networkDetail(t, { id, maxBody = 32000 }) {
  const cap = sessions.get(t.tabId)?.capture;
  if (!cap) throw new Error('Network capture is not running on this tab. Start it: network_record start');
  keepCapture(t.tabId);
  const entry = cap.network.find(r => r.id === Number(id));
  if (!entry) return { error: `Request #${id} not found` };
  if (!entry.recorded) {
    return { error: `Request #${id} was not recorded. Use 'network_record start' to enable body capture.`, id: entry.id, method: entry.method, url: entry.url, status: entry.status };
  }
  const formatBody = (body) => {
    if (body == null) return null;
    if (typeof body === 'object' && body.truncated) return `[Body too large: ${(body.size / 1024).toFixed(1)}KB, not captured]`;
    if (typeof body === 'string' && body.length > maxBody) return body.slice(0, maxBody) + `\n...(truncated, ${body.length} total)`;
    return body;
  };
  return {
    id: entry.id, method: entry.method, url: entry.url,
    status: entry.status, duration: entry.duration, type: entry.type,
    responseSize: entry.responseSize,
    requestHeaders: entry.requestHeaders || null,
    requestBody: formatBody(entry.requestBody),
    responseHeaders: entry.responseHeaders || null,
    responseBody: formatBody(entry.responseBody),
  };
}

async function waitNetworkIdle(t, { quietMs = 500, maxRequestAgeMs = 30_000, timeout = 10_000 }) {
  const cap = sessions.get(t.tabId)?.capture;
  keepCapture(t.tabId);
  if (!cap) {
    throw new Error(
      'wait --network-idle needs network capture, which is not running on this tab.\n' +
      '  Start it first:  cockpit browser <id> network_record start   (or run `network` once)'
    );
  }
  const start = Date.now();
  let quietSince = null;
  while (Date.now() - start < timeout) {
    const now = Date.now();
    const inflight = cap.network.filter(e => e.status == null && (now - e.startTime) < maxRequestAgeMs).length;
    if (inflight === 0) {
      if (quietSince == null) quietSince = now;
      if (now - quietSince >= quietMs) return { waited: `network-idle (quiet=${quietMs}ms)`, elapsedMs: now - start };
    } else {
      quietSince = null;
    }
    await new Promise(r => setTimeout(r, 50));
  }
  throw new Error(`Wait timeout after ${timeout}ms (network still busy)`);
}

// Restore badges after a worker restart.
ready.then(() => updateAllBadges());
