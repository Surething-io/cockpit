/**
 * chrome.debugger sessions, one per tab, shared by the service worker and the
 * CDP tools (tab-tools.js).
 *
 * A session attaches on demand and detaches IDLE_DETACH_MS after its last use:
 * Chrome shows its "is debugging this browser" bar on every tab while attached,
 * so let go soon after a burst of commands (long enough that a burst shares one
 * attach instead of flashing the bar per command). It stays attached while
 * something lives only as long as the session:
 *   - capture   — console / network capture (has its own TTL);
 *   - overrides — viewport, network, media, … emulation: Chrome drops every
 *                 override the moment the debugger detaches;
 *   - coverage  — a running JS / CSS coverage recording;
 *   - dialog    — an open alert / confirm / prompt the agent has to answer.
 *
 * Page.enable is turned on with every attach. It is not observable by the page
 * (unlike Runtime.enable), and it is how JavaScript dialogs are seen: Chrome
 * also re-announces a dialog that was already open when the session attached.
 */

const IDLE_DETACH_MS = 5_000;
const LOG = '[OpenCockpit Bridge]';

/** tabId → session */
export const sessions = new Map();

export function session(tabId) {
  let s = sessions.get(tabId);
  if (!s) {
    s = {
      attached: false, attaching: null, idleTimer: null,
      capture: null, overrides: {}, coverage: null, dialog: null, dialogWaiters: [],
    };
    sessions.set(tabId, s);
  }
  return s;
}

export function hasOverrides(s) {
  return !!s && Object.keys(s.overrides).length > 0;
}

// ── Who is being driven, and why (toolbar icon, popup, `tabs`) ───────────

const changeListeners = new Set();
let changeTimer = null;

/** Called (debounced) whenever a session attaches, detaches or changes what keeps it. */
export function onSessionsChanged(fn) {
  changeListeners.add(fn);
}

export function notifySessions() {
  clearTimeout(changeTimer);
  changeTimer = setTimeout(() => { for (const fn of changeListeners) fn(); }, 100);
}

/** Why a session is still attached, in words for the popup. */
export function sessionReasons(s) {
  const out = [];
  if (s.dialog) out.push(`${s.dialog.type}() dialog open`);
  if (s.capture) out.push('console & network capture');
  const o = s.overrides;
  if (o.viewport) out.push(`${o.viewport.device} viewport`);
  if (o.media?.colorScheme) out.push(`${o.media.colorScheme} theme`);
  if (o.media?.type) out.push(`${o.media.type} media`);
  if (o.media?.reducedMotion) out.push('reduced motion');
  if (o.network) out.push(`${o.network.label} network`);
  if (o.cpu) out.push(`CPU ${o.cpu}x slower`);
  if (o.block) out.push('blocking URLs');
  if (s.coverage) out.push('recording coverage');
  return out;
}

/** Attached tabs: [{ tabId, reasons, captureUntil }]. No reasons = a command burst, about to let go. */
export function debuggingTabs() {
  const out = [];
  for (const [tabId, s] of sessions) {
    if (!s.attached) continue;
    out.push({ tabId, reasons: sessionReasons(s), captureUntil: s.capture?.until || null });
  }
  return out;
}

/** Everything that dies with the session — reset after a detach. */
function clearSessionState(s) {
  clearTimeout(s.idleTimer);
  if (s.capture) clearTimeout(s.capture.ttlTimer);
  s.capture = null;
  s.overrides = {};
  s.coverage = null;
  setDialog(s, null);
  notifySessions();
}

export async function attach(tabId) {
  const s = session(tabId);
  if (s.attached) return s;
  if (!s.attaching) {
    s.attaching = chrome.debugger.attach({ tabId }, '1.3')
      .then(async () => {
        s.attached = true;
        notifySessions();
        await chrome.debugger.sendCommand({ tabId }, 'Page.enable').catch(() => {});
      })
      .finally(() => { s.attaching = null; });
  }
  await s.attaching;
  return s;
}

export function touch(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  clearTimeout(s.idleTimer);
  notifySessions();
  if (s.capture || s.coverage || s.dialog || hasOverrides(s)) return;
  s.idleTimer = setTimeout(() => detach(tabId), IDLE_DETACH_MS);
}

/**
 * Chrome drops most overrides with the session, but NOT the device metrics
 * (viewport size): a detached tab would stay phone-sized, reload included.
 * Clear it explicitly while still attached.
 */
async function clearStickyOverrides(tabId) {
  await chrome.debugger.sendCommand({ tabId }, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
}

export async function detach(tabId) {
  const s = sessions.get(tabId);
  if (!s) return;
  const hadViewport = !!s.overrides.viewport;
  clearSessionState(s);
  if (s.attached) {
    s.attached = false;
    if (hadViewport) await clearStickyOverrides(tabId);
    await chrome.debugger.detach({ tabId }).catch(() => {});
  }
}

export async function cdp(tabId, method, params) {
  await attach(tabId);
  try {
    return await chrome.debugger.sendCommand({ tabId }, method, params);
  } finally {
    touch(tabId);
  }
}

export function forgetSession(tabId) {
  const s = sessions.get(tabId);
  if (s) clearSessionState(s);
  sessions.delete(tabId);
}

chrome.debugger.onDetach.addListener((source, reason) => {
  const s = sessions.get(source.tabId);
  if (!s) return;
  const hadViewport = !!s.overrides.viewport;
  s.attached = false;
  clearSessionState(s);
  if (reason === 'canceled_by_user') console.warn(LOG, `debugger detached by the user on tab ${source.tabId}`);
  // Cancelled from Chrome's bar (or the tab crashed) while a viewport was
  // emulated: hop back on just long enough to give the page its size back.
  if (hadViewport && reason !== 'target_closed') {
    chrome.debugger.attach({ tabId: source.tabId }, '1.3')
      .then(() => clearStickyOverrides(source.tabId))
      .then(() => chrome.debugger.detach({ tabId: source.tabId }))
      .catch(() => {});
  }
});

// ── JavaScript dialogs ──────────────────────────────────────────────────

function setDialog(s, dialog) {
  if (s.dialog !== dialog) notifySessions();
  s.dialog = dialog;
  if (dialog) {
    const waiters = s.dialogWaiters.splice(0);
    for (const w of waiters) w(dialog);
  }
}

/** Resolves with the dialog as soon as one is open (now or later); never rejects. */
export function nextDialog(tabId) {
  const s = session(tabId);
  if (s.dialog) return { promise: Promise.resolve(s.dialog), cancel() {} };
  let resolve;
  const promise = new Promise((r) => { resolve = r; });
  s.dialogWaiters.push(resolve);
  return {
    promise,
    cancel() { const i = s.dialogWaiters.indexOf(resolve); if (i >= 0) s.dialogWaiters.splice(i, 1); },
  };
}

/**
 * Is a dialog open in the tab? Attaches if needed (Chrome then re-announces an
 * open dialog within a few hundred ms) and waits at most `ms` for it.
 */
export async function probeDialog(tabId, ms = 800) {
  const s = await attach(tabId);
  if (s.dialog) return s.dialog;
  const w = nextDialog(tabId);
  const found = await Promise.race([w.promise, new Promise((r) => setTimeout(() => r(null), ms))]);
  w.cancel();
  touch(tabId);
  return found;
}

/** `cockpit browser <id> dialog accept` — the text the agent sees in an error. */
export function describeDialog(d) {
  const kind = d.type === 'beforeunload' ? 'a "leave this page?"' : d.type === 'alert' ? 'an alert()' : `a ${d.type}()`;
  return `${kind} dialog is open: ${JSON.stringify(d.message || '')}`;
}

// ── Page events every session listens to ────────────────────────────────

const fileChooserWaiters = new Map(); // tabId → resolve

export function nextFileChooser(tabId, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => { fileChooserWaiters.delete(tabId); resolve(null); }, ms);
    fileChooserWaiters.set(tabId, (p) => { clearTimeout(timer); fileChooserWaiters.delete(tabId); resolve(p); });
  });
}

const dragWaiters = new Map(); // tabId → resolve

export function onDragIntercepted(tabId, fn) {
  dragWaiters.set(tabId, fn);
  return () => dragWaiters.delete(tabId);
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  const s = sessions.get(source.tabId);
  if (!s) return;
  switch (method) {
    case 'Page.javascriptDialogOpening':
      clearTimeout(s.idleTimer);
      setDialog(s, {
        type: params.type, message: params.message, defaultPrompt: params.defaultPrompt ?? null,
        url: params.url, since: Date.now(),
      });
      break;
    case 'Page.javascriptDialogClosed':
      setDialog(s, null);
      touch(source.tabId);
      break;
    case 'Page.fileChooserOpened':
      fileChooserWaiters.get(source.tabId)?.(params);
      break;
    case 'Input.dragIntercepted':
      dragWaiters.get(source.tabId)?.(params.data);
      break;
  }
});
