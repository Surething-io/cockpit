/**
 * CDP-backed tools for tabs: trusted input, frames, dialogs, uploads,
 * screenshots, drag, scroll, event listeners, performance, coverage and
 * emulation (viewport / network / CPU / media …).
 *
 * Everything here acts on a granted tab (the service worker checks the grant
 * before calling in). DOM lookups still go through page-core.js in the
 * extension's isolated world; CDP is used for what the DOM cannot do.
 *
 * Frames: a ref from inside an iframe reads `f<frameId>:e<N>#v<M>` (snapshot
 * prints them that way). Trusted input into a frame adds the frame's offset in
 * the top page, found by asking the parent document which <iframe> the child
 * window is. Chrome only routes real input into a cross-origin (out-of-process)
 * frame while the tab is visible, so in a background tab those actions fall
 * back to DOM events and say so.
 */

import {
  sessions, session, attach, touch, cdp, hasOverrides,
  nextDialog, probeDialog, describeDialog, nextFileChooser, onDragIntercepted,
} from './debugger-session.js';

let runCore = null;

/** The service worker hands over its page-core runner (it owns injection). */
export function initTabTools(deps) {
  runCore = deps.runCore;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ============================================================================
// Errors
// ============================================================================

export function dialogError(d) {
  const answer = d.type === 'prompt'
    ? 'cockpit browser <id> dialog accept --text "…"  (or: dialog dismiss)'
    : 'cockpit browser <id> dialog accept | dismiss';
  return Object.assign(
    new Error(`The page is blocked: ${describeDialog(d)}\n  Answer it first: ${answer}`),
    { code: 'DIALOG_OPEN' },
  );
}

/** Thrown inside an input sequence when the page opened a dialog mid-way. */
class DialogInterrupt extends Error {
  constructor(dialog) { super('dialog opened'); this.dialog = dialog; }
}

/** What the agent is told when its own action opened a dialog. */
function dialogResult(d) {
  return {
    dialogOpened: { type: d.type, message: d.message, defaultPrompt: d.defaultPrompt },
    next: d.type === 'prompt' ? 'dialog accept --text "…" | dialog dismiss' : 'dialog accept | dialog dismiss',
  };
}

/**
 * Run `promise` (a page-core call on a tab), but do not sit out its timeout if
 * a JavaScript dialog froze the page: a dialog the session already saw fails
 * at once; otherwise, after `afterMs` without an answer, attach and ask.
 */
export async function watchDialogs(tabId, promise, afterMs = 2000) {
  promise.catch(() => {});
  const known = sessions.get(tabId)?.dialog;
  if (known) throw dialogError(known);
  let timer;
  const probe = new Promise((resolve) => {
    timer = setTimeout(() => { probeDialog(tabId).then((d) => d && resolve(d), () => {}); }, afterMs);
  });
  const w = sessions.get(tabId)?.attached ? nextDialog(tabId) : null;
  try {
    const r = await Promise.race([
      promise.then((v) => ({ v })),
      probe.then((d) => ({ d })),
      ...(w ? [w.promise.then((d) => ({ d }))] : []),
    ]);
    if (r.d) throw dialogError(r.d);
    return r.v;
  } finally {
    clearTimeout(timer);
    w?.cancel();
  }
}

/**
 * Chrome acknowledges a pointer move / wheel only when the page draws its next
 * frame, and a background tab draws none — the call would hang until the
 * debugger detaches. They are still delivered in order, so wait briefly and
 * move on.
 */
const SOFT_ACK_MS = 250;
const softAck = (method, params) =>
  method === 'Input.dispatchMouseEvent' && (params.type === 'mouseMoved' || params.type === 'mouseWheel');

/** A CDP Input.* call that returns early (DialogInterrupt) if it opens a dialog. */
async function input(tabId, method, params) {
  const s = await attach(tabId);
  if (s.dialog) throw new DialogInterrupt(s.dialog);
  const w = nextDialog(tabId);
  const p = cdp(tabId, method, params);
  p.catch(() => {});
  try {
    const r = await Promise.race([
      p.then(() => null),
      w.promise,
      ...(softAck(method, params) ? [sleep(SOFT_ACK_MS).then(() => null)] : []),
    ]);
    if (r) throw new DialogInterrupt(r);
  } finally {
    w.cancel();
  }
}

/** Run an input sequence; a dialog it opens becomes part of the result. */
async function guarded(fn) {
  try {
    return await fn();
  } catch (e) {
    if (e instanceof DialogInterrupt) return { partial: true, ...dialogResult(e.dialog) };
    throw e;
  }
}

// ============================================================================
// Frames
// ============================================================================

const FRAME_REF = /^f(\d+):(e\d+#v\d+)$/;

/** Split `f7:e3#v1` into frame 7 + ref; `--frame N` picks a frame for selector / text targets. */
export function targetFrame(params) {
  let frameId = params.frame != null ? Number(params.frame) : 0;
  delete params.frame;
  if (typeof params.ref === 'string') {
    const m = params.ref.match(FRAME_REF);
    if (m) { frameId = Number(m[1]); params.ref = m[2]; }
  }
  if (!Number.isInteger(frameId) || frameId < 0) throw new Error(`Bad frame "${frameId}"`);
  return frameId;
}

function originOf(url) {
  try { return new URL(url).origin; } catch { return ''; }
}

async function frameInfo(tabId) {
  const frames = await chrome.webNavigation.getAllFrames({ tabId });
  return new Map(frames.map((f) => [f.frameId, f]));
}

/** Where does the parent document draw `childId`'s <iframe>? (null when unknown) */
async function frameOwner(tabId, parentId, childId) {
  const nonce = `p${Math.random().toString(36).slice(2)}`;
  const owner = runCore(tabId, parentId, '_frameOwner', { nonce, timeout: 1500 });
  owner.catch(() => {});
  await sleep(40);
  await runCore(tabId, childId, '_frameProbe', { nonce }).catch(() => {});
  return owner.catch(() => null);
}

/** Offset of frame `frameId`'s viewport inside the top-level viewport. */
async function frameOffset(tabId, frameId, frames) {
  let x = 0, y = 0;
  let id = frameId;
  const all = frames || await frameInfo(tabId);
  while (id !== 0) {
    const f = all.get(id);
    if (!f) throw new Error(`Frame f${frameId} is gone (the page changed) — re-run snapshot`);
    const owner = await frameOwner(tabId, f.parentFrameId, id);
    if (!owner) throw new Error(`Cannot place frame f${id} in its parent page — re-run snapshot, or use --dom`);
    x += owner.x; y += owner.y;
    id = f.parentFrameId;
  }
  return { x, y };
}

/**
 * Can Chrome deliver real input into this frame right now? Not into a
 * cross-origin frame of a background tab (it has not been composited).
 */
async function realInputReaches(t, frameId) {
  if (frameId === 0) return true;
  const tab = await chrome.tabs.get(t.tabId).catch(() => t.tab);
  if (tab.active) return true;
  const frames = await frameInfo(t.tabId);
  const f = frames.get(frameId);
  return !!f && originOf(f.url) === originOf(frames.get(0)?.url || '');
}

const BACKGROUND_FRAME_NOTE =
  'The tab is in the background, and Chrome only delivers real input into a cross-origin frame of a visible tab, ' +
  'so DOM events were used. For real input: cockpit browser <id> show, then repeat.';

/** page-core `_locate` in any frame, in top-level viewport coordinates. */
async function locate(t, frameId, params) {
  const loc = await runCore(t.tabId, frameId, '_locate', params);
  if (frameId) {
    const off = await frameOffset(t.tabId, frameId);
    loc.x += off.x; loc.y += off.y; loc.left += off.x; loc.top += off.y;
  }
  return loc;
}

function touchMode(tabId) {
  return !!sessions.get(tabId)?.overrides.viewport?.touch;
}

// ============================================================================
// Trusted input
// ============================================================================

/**
 * Click / hover / type / key / scroll through Chrome's input pipeline. Falls
 * back to page-core DOM events where real input cannot reach (see above).
 */
export async function trustedInput(t, action, params) {
  const frameId = targetFrame(params);
  if (!(await realInputReaches(t, frameId))) {
    const res = await runCore(t.tabId, frameId, action, params);
    return { ...(res && typeof res === 'object' ? res : { result: res }), input: 'dom', note: BACKGROUND_FRAME_NOTE };
  }
  if (action === 'scroll' && !(await chrome.tabs.get(t.tabId).catch(() => t.tab)).active) {
    // Wheel scrolling happens in the compositor, which a background tab does not run.
    const res = await runCore(t.tabId, frameId, 'scroll', params);
    return { ...res, input: 'dom', note: 'The tab is in the background, where the wheel does not scroll; the page was scrolled directly. For real wheel / swipe input: cockpit browser <id> show, then repeat.' };
  }
  switch (action) {
    case 'click': return guarded(() => trustedClick(t, frameId, params));
    case 'hover': return guarded(() => trustedHover(t, frameId, params));
    case 'type': return guarded(() => trustedType(t, frameId, params));
    case 'key': return guarded(() => trustedKey(t, params));
    case 'scroll': return guarded(() => trustedScroll(t, frameId, params));
  }
  throw new Error(`No trusted input for ${action}`);
}

async function trustedClick(t, frameId, params) {
  const loc = await locate(t, frameId, params);
  const hold = Number(params.hold) > 0 ? Math.min(Number(params.hold), 10_000) : 0;
  const base = {
    clicked: loc.label, nth: params.nth || 0, input: 'trusted',
    ...(params.at != null ? { at: params.at } : {}), ...(hold ? { held: hold } : {}),
  };
  if (touchMode(t.tabId)) {
    // An emulated phone gets a finger, not a mouse: touchstart / touchend,
    // then the click Chrome derives from the tap — what touch-only handlers expect.
    const point = { x: loc.x, y: loc.y, id: 1 };
    await input(t.tabId, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [point] });
    if (hold) await sleep(hold);
    await input(t.tabId, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
    return { ...base, pointer: 'touch' };
  }
  const m = { x: loc.x, y: loc.y, button: 'left', clickCount: 1 };
  await input(t.tabId, 'Input.dispatchMouseEvent', { ...m, type: 'mouseMoved', button: 'none', clickCount: 0 });
  await input(t.tabId, 'Input.dispatchMouseEvent', { ...m, type: 'mousePressed' });
  if (hold) await sleep(hold);
  await input(t.tabId, 'Input.dispatchMouseEvent', { ...m, type: 'mouseReleased' });
  return base;
}

async function trustedHover(t, frameId, params) {
  // A real pointer move: fires mouseover/mouseenter AND applies CSS :hover,
  // which synthetic DOM events cannot.
  const loc = await locate(t, frameId, params);
  await input(t.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x: loc.x, y: loc.y, button: 'none' });
  return { hovered: loc.label, input: 'trusted' };
}

/** Key event fields for one printable ASCII character typed on a US layout. */
function asciiKey(ch) {
  if (/^[a-z]$/.test(ch)) return { key: ch, code: `Key${ch.toUpperCase()}`, keyCode: ch.toUpperCase().charCodeAt(0), shift: false };
  if (/^[A-Z]$/.test(ch)) return { key: ch, code: `Key${ch}`, keyCode: ch.charCodeAt(0), shift: true };
  if (/^[0-9]$/.test(ch)) return { key: ch, code: `Digit${ch}`, keyCode: ch.charCodeAt(0), shift: false };
  if (ch === ' ') return { key: ' ', code: 'Space', keyCode: 32, shift: false };
  return { key: ch, code: '', keyCode: 0, shift: /[~!@#$%^&*()_+{}|:"<>?]/.test(ch) };
}

/**
 * Type like a person: every ASCII character is a real key press (keydown /
 * keypress / input / keyup, all isTrusted), Enter and Tab for \n and \t.
 * Characters no single key produces (CJK, emoji…) are committed the way an
 * IME does it, via Input.insertText. `--insert` commits the whole text at once.
 */
async function trustedType(t, frameId, { ref, text, clear, insert }) {
  if (typeof text !== 'string') throw new Error('type requires --text');
  await runCore(t.tabId, frameId, '_locate', { ref, focus: true, clear: !!clear });
  if (insert) {
    await input(t.tabId, 'Input.insertText', { text });
    return { typed: text, ref, input: 'trusted', mode: 'insert' };
  }
  for (const ch of text) {
    if (ch === '\n' || ch === '\r') { await trustedKey(t, { key: 'Enter' }); continue; }
    if (ch === '\t') { await trustedKey(t, { key: 'Tab' }); continue; }
    if (ch.charCodeAt(0) < 0x20 || ch.charCodeAt(0) > 0x7e) {
      await input(t.tabId, 'Input.insertText', { text: ch });
      continue;
    }
    const k = asciiKey(ch);
    const base = { key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, modifiers: k.shift ? 8 : 0 };
    await input(t.tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyDown', text: ch, unmodifiedText: ch });
    await input(t.tabId, 'Input.dispatchKeyEvent', { ...base, type: 'keyUp' });
  }
  return { typed: text, ref, input: 'trusted', mode: 'keys' };
}

const KEY_DEFS = {
  Enter: { code: 'Enter', keyCode: 13, text: '\r' },
  Tab: { code: 'Tab', keyCode: 9 },
  Escape: { code: 'Escape', keyCode: 27 },
  Backspace: { code: 'Backspace', keyCode: 8 },
  Delete: { code: 'Delete', keyCode: 46 },
  ArrowUp: { code: 'ArrowUp', keyCode: 38 },
  ArrowDown: { code: 'ArrowDown', keyCode: 40 },
  ArrowLeft: { code: 'ArrowLeft', keyCode: 37 },
  ArrowRight: { code: 'ArrowRight', keyCode: 39 },
  Home: { code: 'Home', keyCode: 36 },
  End: { code: 'End', keyCode: 35 },
  PageUp: { code: 'PageUp', keyCode: 33 },
  PageDown: { code: 'PageDown', keyCode: 34 },
  Space: { code: 'Space', keyCode: 32, text: ' ', key: ' ' },
};

async function trustedKey(t, { key }) {
  if (!key) throw new Error('key requires a key, e.g. Enter or Control+a');
  const parts = String(key).split('+');
  const main = parts.pop();
  const mod = (parts.includes('Alt') ? 1 : 0) |
    ((parts.includes('Control') || parts.includes('Ctrl')) ? 2 : 0) |
    ((parts.includes('Meta') || parts.includes('Cmd')) ? 4 : 0) |
    (parts.includes('Shift') ? 8 : 0);
  const def = KEY_DEFS[main] || (main.length === 1
    ? { code: /[a-z]/i.test(main) ? `Key${main.toUpperCase()}` : '', keyCode: main.toUpperCase().charCodeAt(0), text: main }
    : { code: main, keyCode: 0 });
  const keyName = def.key || main;
  const text = mod & ~8 ? undefined : def.text;
  await input(t.tabId, 'Input.dispatchKeyEvent', {
    type: text ? 'keyDown' : 'rawKeyDown', key: keyName, code: def.code,
    windowsVirtualKeyCode: def.keyCode, modifiers: mod, text,
  });
  await input(t.tabId, 'Input.dispatchKeyEvent', {
    type: 'keyUp', key: keyName, code: def.code, windowsVirtualKeyCode: def.keyCode, modifiers: mod,
  });
  return { pressed: key, input: 'trusted' };
}

/**
 * A real wheel turn (or, on an emulated touch device, a finger swipe) at the
 * element / viewport centre: virtual lists, infinite scroll and scroll-linked
 * effects see the same events a person makes.
 */
async function trustedScroll(t, frameId, params) {
  const amount = Number(params.amount) || 300;
  const dir = params.direction || 'down';
  const dx = dir === 'left' ? -amount : dir === 'right' ? amount : 0;
  const dy = dir === 'up' ? -amount : dir === 'down' ? amount : 0;
  if (!dx && !dy) throw new Error('scroll --direction must be up, down, left or right');
  let x, y;
  if (params.ref || params.selector || params.text) {
    const loc = await locate(t, frameId, { ref: params.ref, selector: params.selector, text: params.text, noScroll: true });
    if (!loc.inView) throw new Error(`${loc.label} is outside the viewport; scroll the page first`);
    ({ x, y } = loc);
  } else {
    const m = await cdp(t.tabId, 'Page.getLayoutMetrics');
    x = m.cssVisualViewport.clientWidth / 2;
    y = m.cssVisualViewport.clientHeight / 2;
  }
  if (touchMode(t.tabId)) {
    // Finger moves opposite to the content: swipe up to scroll down.
    await input(t.tabId, 'Input.synthesizeScrollGesture', {
      x, y, xDistance: -dx, yDistance: -dy, speed: 1200, gestureSourceType: 'touch',
    });
    return { scrolled: dir, amount, input: 'trusted', pointer: 'touch' };
  }
  await input(t.tabId, 'Input.dispatchMouseEvent', { type: 'mouseWheel', x, y, deltaX: dx, deltaY: dy });
  await sleep(120); // let the wheel scroll land before the next command reads the page
  return { scrolled: dir, amount, input: 'trusted' };
}

// ============================================================================
// Drag
// ============================================================================

/**
 * Press, move in steps, release — pointer-driven libraries (sortable lists,
 * sliders, canvases) see real pointer events. If the page starts a native
 * HTML5 drag, Chrome hands the drag data over (Input.setInterceptDrags) and
 * the drop is delivered with Input.dispatchDragEvent.
 */
export async function dragCommand(t, params) {
  const frameId = targetFrame(params);
  if (!(await realInputReaches(t, frameId))) {
    throw new Error('Drag needs real input, which Chrome cannot deliver into this cross-origin frame while the tab is in the background. Run: cockpit browser <id> show, then repeat.');
  }
  const from = await locate(t, frameId, { ref: params.ref, selector: params.selector, text: params.text });
  let to;
  if (params.to) {
    // A ref (f7:e3#v1 / e3#v1), else a CSS selector in the source's frame.
    const raw = String(params.to);
    const toParams = /^(f\d+:)?e\d+#v\d+$/.test(raw) ? { ref: raw } : { selector: raw, frame: frameId };
    const toFrame = targetFrame(toParams);
    if (toFrame !== frameId) throw new Error('drag starts and ends in the same frame');
    to = await locate(t, toFrame, { ...toParams, noScroll: true });
    if (!to.inView) throw new Error(`Drop target ${params.to} is not on screen together with the source; scroll so both are visible, or use --dx/--dy`);
  } else if (params.dx != null || params.dy != null) {
    to = { x: from.x + (Number(params.dx) || 0), y: from.y + (Number(params.dy) || 0), label: `(${params.dx || 0},${params.dy || 0})` };
  } else {
    throw new Error('drag needs a target: drag <from-ref> <to-ref>, or --dx N / --dy N');
  }
  const steps = Math.max(2, Math.min(Number(params.steps) || 12, 60));
  const at = (i) => ({ x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps });

  return guarded(async () => {
    if (touchMode(t.tabId)) {
      await input(t.tabId, 'Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ ...at(0), id: 1 }] });
      for (let i = 1; i <= steps; i++) {
        await input(t.tabId, 'Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ ...at(i), id: 1 }] });
        await sleep(16);
      }
      await input(t.tabId, 'Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] });
      return { dragged: from.label, to: to.label || params.to, mode: 'touch', input: 'trusted' };
    }
    let dragData = null;
    const off = onDragIntercepted(t.tabId, (d) => { dragData = d; });
    await cdp(t.tabId, 'Input.setInterceptDrags', { enabled: true });
    try {
      const p0 = at(0);
      await input(t.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...p0, button: 'none' });
      await input(t.tabId, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...p0, button: 'left', buttons: 1, clickCount: 1 });
      for (let i = 1; i <= steps && !dragData; i++) {
        await input(t.tabId, 'Input.dispatchMouseEvent', { type: 'mouseMoved', ...at(i), button: 'left', buttons: 1 });
        await sleep(16);
      }
      if (dragData) {
        const end = at(steps);
        for (const type of ['dragEnter', 'dragOver', 'drop']) {
          await input(t.tabId, 'Input.dispatchDragEvent', { type, ...end, data: dragData, modifiers: 0 });
        }
      }
      await input(t.tabId, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...at(steps), button: 'left', buttons: 0, clickCount: 1 });
    } finally {
      off();
      await cdp(t.tabId, 'Input.setInterceptDrags', { enabled: false }).catch(() => {});
    }
    return { dragged: from.label, to: to.label || params.to, mode: dragData ? 'html5' : 'pointer', input: 'trusted' };
  });
}

// ============================================================================
// Remote objects for marked elements
// ============================================================================

/**
 * Find the element page-core tagged with `nonce` as a CDP remote object.
 * Searches open shadow roots and same-origin iframes; a cross-origin
 * (out-of-process) frame is not reachable from the tab's debugger session.
 */
async function markedObject(tabId, nonce) {
  const res = await cdp(tabId, 'Runtime.evaluate', {
    expression: `(() => {
      const sel = '[data-cockpit-mark="${nonce}"]';
      const find = (root) => {
        const hit = root.querySelector(sel);
        if (hit) return hit;
        for (const el of root.querySelectorAll('*')) {
          if (el.shadowRoot) { const f = find(el.shadowRoot); if (f) return f; }
          if (el.tagName === 'IFRAME' || el.tagName === 'FRAME') {
            try { const d = el.contentDocument; if (d) { const f = find(d); if (f) return f; } } catch {}
          }
        }
        return null;
      };
      const el = find(document);
      if (el) el.removeAttribute('data-cockpit-mark');
      return el;
    })()`,
  });
  return res.result?.objectId || null;
}

async function release(tabId, objectId) {
  if (objectId) await cdp(tabId, 'Runtime.releaseObject', { objectId }).catch(() => {});
}

// ============================================================================
// Upload
// ============================================================================

const FILE_ACCESS_HINT =
  'Uploading needs "Allow access to file URLs" for OpenCockpit Bridge.\n' +
  `  Turn it on: chrome://extensions/?id=${chrome.runtime.id} → "Allow access to file URLs", then repeat.`;

/**
 * Put local files into a file input — either the <input type=file> itself
 * (often hidden), or the button that opens the file chooser, which is clicked
 * with the chooser intercepted so no OS dialog appears.
 */
export async function uploadCommand(t, params) {
  const files = Array.isArray(params.files) ? params.files.map(String) : [];
  if (!files.length) throw new Error('upload needs at least one file: upload <ref> <file> [file…]');
  if (!(await chrome.extension.isAllowedFileSchemeAccess())) throw Object.assign(new Error(FILE_ACCESS_HINT), { code: 'FILE_ACCESS' });
  const frameId = targetFrame(params);
  const target = { ref: params.ref, selector: params.selector, text: params.text, nth: params.nth };
  const names = files.map((f) => f.split(/[\\/]/).pop());

  const mark = await runCore(t.tabId, frameId, '_mark', target);
  if (mark.tag === 'input' && mark.type === 'file') {
    if (files.length > 1 && !mark.multiple) throw new Error(`${mark.label} takes one file (no "multiple" attribute)`);
    const objectId = await markedObject(t.tabId, mark.nonce);
    if (!objectId) {
      await runCore(t.tabId, frameId, '_unmark', { nonce: mark.nonce }).catch(() => {});
      throw new Error('That file input is inside a cross-origin frame, which Cockpit cannot upload into. Open the frame\'s page in its own tab instead.');
    }
    try {
      await setFiles(t.tabId, { objectId, files });
    } finally {
      await release(t.tabId, objectId);
    }
    return { uploaded: names, via: 'input', target: mark.label };
  }

  // A control that opens the chooser: click it and catch the chooser.
  await runCore(t.tabId, frameId, '_unmark', { nonce: mark.nonce }).catch(() => {});
  if (frameId && !(await realInputReaches(t, frameId))) {
    throw new Error('The button is in a cross-origin frame of a background tab; run: cockpit browser <id> show, then repeat.');
  }
  await cdp(t.tabId, 'Page.setInterceptFileChooserDialog', { enabled: true });
  try {
    const chooser = nextFileChooser(t.tabId, 5_000);
    const clicked = await guarded(() => trustedClick(t, frameId, { ...target }));
    if (clicked.dialogOpened) return clicked;
    const c = await chooser;
    if (!c) {
      throw new Error(`Clicking ${mark.label} did not open a file chooser. Point upload at the <input type=file> (snapshot marks it "file") or the control that opens it.`);
    }
    if (c.mode === 'selectSingle' && files.length > 1) throw new Error('This file chooser takes one file');
    await setFiles(t.tabId, { backendNodeId: c.backendNodeId, files });
  } finally {
    await cdp(t.tabId, 'Page.setInterceptFileChooserDialog', { enabled: false }).catch(() => {});
  }
  return { uploaded: names, via: 'chooser', target: mark.label };
}

async function setFiles(tabId, args) {
  try {
    await cdp(tabId, 'DOM.setFileInputFiles', args);
  } catch (e) {
    if (/not allowed/i.test(String(e.message))) throw Object.assign(new Error(FILE_ACCESS_HINT), { code: 'FILE_ACCESS' });
    throw e;
  }
}

// ============================================================================
// Screenshots: full page / one element
// ============================================================================

const MAX_FULL_HEIGHT = 16_384;

export async function screenshotTab(t, params) {
  const frameId = targetFrame(params);
  let clip;
  let note;
  if (params.full) {
    const m = await cdp(t.tabId, 'Page.getLayoutMetrics');
    const width = Math.ceil(m.cssContentSize.width);
    const height = Math.ceil(m.cssContentSize.height);
    clip = { x: 0, y: 0, width, height: Math.min(height, MAX_FULL_HEIGHT), scale: 1 };
    if (height > MAX_FULL_HEIGHT) note = `The page is ${height}px tall; captured the top ${MAX_FULL_HEIGHT}px.`;
  } else {
    const loc = await locate(t, frameId, { ref: params.ref, selector: params.selector, text: params.text, nth: params.nth });
    const m = await cdp(t.tabId, 'Page.getLayoutMetrics');
    const vv = m.cssVisualViewport;
    clip = { x: loc.left + vv.pageX, y: loc.top + vv.pageY, width: Math.max(1, loc.width), height: Math.max(1, loc.height), scale: 1 };
  }
  const res = await withTimeout(
    cdp(t.tabId, 'Page.captureScreenshot', { format: 'png', clip, captureBeyondViewport: !!params.full }),
    20_000, 'Screenshot timed out',
  );
  return { image: `data:image/png;base64,${res.data}`, format: 'png', ...(note ? { note } : {}) };
}

/** Plain viewport capture of a tab through CDP (works in background tabs). */
export async function screenshotViewport(t) {
  const res = await withTimeout(cdp(t.tabId, 'Page.captureScreenshot', { format: 'png' }), 10_000,
    'Background-tab screenshot timed out; open the tab (cockpit browser <id> show) and retry');
  return { image: `data:image/png;base64,${res.data}`, format: 'png' };
}

function withTimeout(promise, ms, message) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(message)), ms); }),
  ]).finally(() => clearTimeout(timer));
}

// ============================================================================
// Dialogs
// ============================================================================

/** `dialog` — show; `dialog accept [--text T]` / `dialog dismiss` — answer. */
export async function dialogCommand(t, params) {
  const op = params.op;
  if (op && op !== 'accept' && op !== 'dismiss') throw new Error('dialog takes accept or dismiss');
  const d = await probeDialog(t.tabId);
  if (!d) return { open: false };
  const info = { type: d.type, message: d.message, defaultPrompt: d.defaultPrompt };
  if (!op) return { open: true, ...info };
  const promptText = op === 'accept' && d.type === 'prompt'
    ? (params.text != null ? String(params.text) : (d.defaultPrompt || ''))
    : undefined;
  await cdp(t.tabId, 'Page.handleJavaScriptDialog', { accept: op === 'accept', ...(promptText != null ? { promptText } : {}) });
  return { handled: op, ...info, ...(promptText != null ? { promptText } : {}) };
}

// ============================================================================
// Snapshot across frames
// ============================================================================

const MAX_SNAPSHOT_FRAMES = 12;

/**
 * The top document's tree with every reachable iframe's tree nested under its
 * <iframe> line. Refs inside a frame are prefixed `f<frameId>:`.
 */
export async function snapshotTab(t, params) {
  if (params.frame != null) {
    // One frame only (--frame N): its refs still need the frame prefix.
    const frameId = targetFrame(params);
    const tree = await runCore(t.tabId, frameId, 'snapshot', { ...params });
    return frameId && typeof tree === 'string' ? tree.replace(/\[(e\d+#v\d+)\]/g, `[f${frameId}:$1]`) : tree;
  }
  const top = await runCore(t.tabId, 0, 'snapshot', { ...params });
  const frames = await frameInfo(t.tabId);
  const children = [...frames.values()]
    .filter((f) => f.frameId !== 0 && /^(https?|file):/.test(f.url) && !f.errorOccurred)
    .slice(0, MAX_SNAPSHOT_FRAMES);
  if (!children.length || typeof top !== 'string') return top;

  const parts = await Promise.all(children.map(async (f) => {
    const [owner, tree] = await Promise.all([
      frameOwner(t.tabId, f.parentFrameId, f.frameId).catch(() => null),
      runCore(t.tabId, f.frameId, 'snapshot', { ...params }).catch((e) => `# (frame not readable: ${e.message})`),
    ]);
    return { f, owner, tree: typeof tree === 'string' ? tree : JSON.stringify(tree) };
  }));

  const body = (tree) => tree.split('\n').filter((l) => !l.startsWith('# '));
  const prefix = (lines, frameId) => lines.map((l) => l.replace(/\[(e\d+#v\d+)\]/g, `[f${frameId}:$1]`));
  // Stitch bottom-up so nested frames land inside their parent frame first.
  const textOf = new Map([[0, top.split('\n')]]);
  for (const p of parts) textOf.set(p.f.frameId, prefix(body(p.tree), p.f.frameId));
  const depth = (id) => { let d = 0; for (let f = frames.get(id); f && f.frameId !== 0; f = frames.get(f.parentFrameId)) d++; return d; };
  const orphans = [];
  for (const p of [...parts].sort((a, b) => depth(b.f.frameId) - depth(a.f.frameId))) {
    const parentLines = textOf.get(p.f.parentFrameId);
    const lines = textOf.get(p.f.frameId);
    const header = `frame f${p.f.frameId} ${p.f.url.slice(0, 80)}`;
    const ownerRef = p.owner?.ref ? (p.f.parentFrameId ? `f${p.f.parentFrameId}:${p.owner.ref}` : p.owner.ref) : null;
    const at = parentLines && ownerRef ? parentLines.findIndex((l) => l.includes(`[${ownerRef}]`)) : -1;
    if (at < 0) { orphans.push(header, ...lines.map((l) => `  ${l}`)); continue; }
    const indent = parentLines[at].match(/^\s*/)[0] + '  ';
    parentLines.splice(at + 1, 0, `${indent}${header}`, ...lines.map((l) => `${indent}  ${l}`));
  }
  const out = textOf.get(0);
  const bannerEnd = out.findIndex((l) => !l.startsWith('# '));
  out.splice(bannerEnd < 0 ? out.length : bannerEnd, 0,
    '# Frames: refs inside an iframe look like f7:e3#v1 — pass them as-is.');
  if (orphans.length) out.push('# Frames not placed in the tree above:', ...orphans);
  return out.join('\n');
}

// ============================================================================
// Event listeners
// ============================================================================

export async function eventsCommand(t, params) {
  const frameId = targetFrame(params);
  const mark = await runCore(t.tabId, frameId, '_mark', { ref: params.ref, selector: params.selector, text: params.text });
  const objectId = await markedObject(t.tabId, mark.nonce);
  if (!objectId) {
    await runCore(t.tabId, frameId, '_unmark', { nonce: mark.nonce }).catch(() => {});
    const res = await runCore(t.tabId, frameId, 'events', { ref: params.ref });
    return { listeners: res, note: 'Cross-origin frame: only inline on* handlers are visible.' };
  }
  const describe = (l) => ({
    type: l.type,
    ...(l.useCapture ? { capture: true } : {}),
    ...(l.passive ? { passive: true } : {}),
    ...(l.once ? { once: true } : {}),
    handler: (l.handler?.description || '').replace(/\s+/g, ' ').slice(0, 120),
  });
  try {
    const own = await cdp(t.tabId, 'DOMDebugger.getEventListeners', { objectId, depth: 0 });
    // Frameworks (React, Vue, jQuery delegation) listen on the root instead.
    const ancestors = await cdp(t.tabId, 'Runtime.callFunctionOn', {
      objectId,
      functionDeclaration: 'function () { const out = []; for (let n = this.parentElement; n; n = n.parentElement) out.push(n); out.push(document, window); return out; }',
      returnByValue: false,
    });
    const props = await cdp(t.tabId, 'Runtime.getProperties', { objectId: ancestors.result.objectId, ownProperties: true });
    const delegated = {};
    for (const p of props.result) {
      if (!/^\d+$/.test(p.name) || !p.value?.objectId) continue;
      const { listeners } = await cdp(t.tabId, 'DOMDebugger.getEventListeners', { objectId: p.value.objectId, depth: 0 });
      const where = p.value.description || p.value.className;
      for (const l of listeners) (delegated[l.type] ||= new Set()).add(where);
    }
    await release(t.tabId, ancestors.result.objectId);
    return {
      element: mark.label,
      listeners: own.listeners.map(describe),
      onAncestors: Object.fromEntries(Object.entries(delegated).map(([k, v]) => [k, [...v].slice(0, 5)])),
    };
  } finally {
    await release(t.tabId, objectId);
  }
}

// ============================================================================
// Performance metrics and coverage
// ============================================================================

const RUNTIME_METRICS = [
  'Documents', 'Frames', 'JSEventListeners', 'Nodes', 'LayoutCount', 'RecalcStyleCount',
  'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration', 'JSHeapUsedSize', 'JSHeapTotalSize',
];

export async function runtimeMetrics(t) {
  await cdp(t.tabId, 'Performance.enable', { timeDomain: 'timeTicks' });
  try {
    const { metrics } = await cdp(t.tabId, 'Performance.getMetrics');
    const out = {};
    for (const m of metrics) {
      if (!RUNTIME_METRICS.includes(m.name)) continue;
      out[m.name] = /Duration$/.test(m.name) ? `${Math.round(m.value * 1000)}ms`
        : /Size$/.test(m.name) ? `${(m.value / 1048576).toFixed(1)}MB` : m.value;
    }
    return out;
  } finally {
    await cdp(t.tabId, 'Performance.disable').catch(() => {});
  }
}

/** coverage start | stop | status — how much of each script / stylesheet ran. */
export async function coverageCommand(t, params) {
  const op = params.op || 'status';
  const s = session(t.tabId);
  if (op === 'status') return s.coverage ? { running: true, since: new Date(s.coverage.startedAt).toISOString() } : { running: false };
  if (op === 'start') {
    if (s.coverage) return { running: true, alreadyRunning: true };
    await attach(t.tabId);
    s.coverage = { startedAt: Date.now(), sheets: new Map(), js: false, css: false };
    clearTimeout(s.idleTimer);
    const send = (m, p) => chrome.debugger.sendCommand({ tabId: t.tabId }, m, p);
    // Chrome withholds the Profiler domain from extensions; Chromium builds
    // may allow it. Take whichever half is available.
    try {
      await send('Profiler.enable');
      await send('Profiler.startPreciseCoverage', { callCount: false, detailed: true });
      s.coverage.js = true;
    } catch { /* JS coverage unavailable in this browser */ }
    try {
      await send('DOM.enable');
      await send('CSS.enable');
      await send('CSS.startRuleUsageTracking');
      s.coverage.css = true;
    } catch { /* CSS coverage unavailable */ }
    if (!s.coverage.js && !s.coverage.css) {
      s.coverage = null;
      touch(t.tabId);
      throw new Error('This browser does not let extensions record coverage');
    }
    return {
      running: true,
      covers: [s.coverage.js && 'js', s.coverage.css && 'css'].filter(Boolean),
      note: `Use the page, then: coverage stop. Reload now to include what runs at load.${s.coverage.js ? '' : ' (JS coverage is not available to extensions in this browser — CSS only.)'}`,
    };
  }
  if (op !== 'stop') throw new Error('coverage takes start, stop or status');
  if (!s.coverage) return { running: false, note: 'coverage was not running' };
  const send = (m, p) => chrome.debugger.sendCommand({ tabId: t.tabId }, m, p);
  const sheets = s.coverage.sheets;
  try {
    const { result: scripts } = s.coverage.js ? await send('Profiler.takePreciseCoverage') : { result: [] };
    const { ruleUsage } = s.coverage.css ? await send('CSS.stopRuleUsageTracking') : { ruleUsage: [] };
    const covered = { js: s.coverage.js, css: s.coverage.css };
    const js = scripts
      .filter((sc) => sc.url && !sc.url.startsWith('chrome-extension:'))
      .map((sc) => {
        const total = Math.max(0, ...sc.functions.flatMap((f) => f.ranges.map((r) => r.endOffset)));
        const used = usedBytes(sc.functions.flatMap((f) => f.ranges));
        return { url: sc.url, total, used };
      });
    const usedBySheet = new Map();
    for (const r of ruleUsage) {
      if (!r.used) continue;
      const list = usedBySheet.get(r.styleSheetId) || [];
      list.push([r.startOffset, r.endOffset]);
      usedBySheet.set(r.styleSheetId, list);
    }
    const css = [...sheets.values()].map((sh) => ({
      url: sh.url || '(inline <style>)', total: sh.length, used: mergedLength(usedBySheet.get(sh.id) || []),
    }));
    const fmt = (list) => list
      .filter((e) => e.total > 0)
      .map((e) => ({ ...e, unusedPct: Math.round(((e.total - e.used) / e.total) * 100) }))
      .sort((a, b) => (b.total - b.used) - (a.total - a.used))
      .slice(0, 25);
    const sum = (list, k) => list.reduce((n, e) => n + e[k], 0);
    return {
      covered,
      js: fmt(js), css: fmt(css),
      totals: {
        jsBytes: sum(js, 'total'), jsUsed: sum(js, 'used'),
        cssBytes: sum(css, 'total'), cssUsed: sum(css, 'used'),
      },
    };
  } finally {
    s.coverage = null;
    for (const m of ['Profiler.stopPreciseCoverage', 'Profiler.disable', 'CSS.disable', 'DOM.disable']) {
      await send(m).catch(() => {});
    }
    touch(t.tabId);
  }
}

/** Bytes covered by ranges with count > 0, where nested ranges override outer ones. */
function usedBytes(ranges) {
  if (!ranges.length) return 0;
  const points = [...new Set(ranges.flatMap((r) => [r.startOffset, r.endOffset]))].sort((a, b) => a - b);
  // Innermost range wins: sort so that for a segment the last matching range is the narrowest.
  const sorted = [...ranges].sort((a, b) => (b.endOffset - b.startOffset) - (a.endOffset - a.startOffset));
  let used = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    let count = null;
    for (const r of sorted) if (r.startOffset <= a && r.endOffset >= b) count = r.count;
    if (count) used += b - a;
  }
  return used;
}

function mergedLength(spans) {
  const sorted = [...spans].sort((a, b) => a[0] - b[0]);
  let total = 0, end = -1;
  for (const [s, e] of sorted) {
    if (s > end) { total += e - s; end = e; } else if (e > end) { total += e - end; end = e; }
  }
  return total;
}

chrome.debugger.onEvent.addListener((source, method, params) => {
  if (method !== 'CSS.styleSheetAdded') return;
  const cov = sessions.get(source.tabId)?.coverage;
  if (!cov) return;
  const h = params.header;
  cov.sheets.set(h.styleSheetId, { id: h.styleSheetId, url: h.sourceURL, length: h.length });
});

// ============================================================================
// Emulation: viewport, media, network, CPU, blocked URLs
// ============================================================================
//
// CDP overrides belong to the debugger session: they survive navigations and
// reloads in the tab, and (except the viewport size, which detach() clears
// itself) vanish when the debugger detaches. So a tab with any override stays
// attached (no idle detach — Chrome's debugging bar stays up meanwhile) until
// it is reset, released, stopped from the popup, closed, or the user cancels
// the bar.

const IOS_VERSION = '18_5';

/** Chrome's own major version, so the Android UA does not look stale. */
function chromeMajor() {
  return navigator.userAgent.match(/Chrome\/(\d+)/)?.[1] || '130';
}

const DEVICE_PRESETS = {
  iphone: () => ({
    label: 'iPhone 15', width: 393, height: 852, dpr: 3, mobile: true, touch: true,
    userAgent: `Mozilla/5.0 (iPhone; CPU iPhone OS ${IOS_VERSION} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${IOS_VERSION.replace('_', '.')} Mobile/15E148 Safari/604.1`,
    platform: 'iPhone',
  }),
  android: () => ({
    label: 'Pixel 8', width: 412, height: 915, dpr: 2.625, mobile: true, touch: true,
    userAgent: `Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeMajor()}.0.0.0 Mobile Safari/537.36`,
    platform: 'Linux armv8l',
    metadata: {
      brands: navigator.userAgentData?.brands || [],
      platform: 'Android', platformVersion: '14.0.0', architecture: '', model: 'Pixel 8', mobile: true,
    },
  }),
  ipad: () => ({
    label: 'iPad Air', width: 820, height: 1180, dpr: 2, mobile: true, touch: true,
    userAgent: `Mozilla/5.0 (iPad; CPU OS ${IOS_VERSION} like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/${IOS_VERSION.replace('_', '.')} Mobile/15E148 Safari/604.1`,
    platform: 'iPad',
  }),
};
const DEVICE_ALIASES = { mobile: 'iphone', phone: 'iphone', ios: 'iphone', pixel: 'android', tablet: 'ipad' };

/** `iphone` / `android` / `ipad` / `<W>x<H>` (+ flags) → an emulation spec. */
function viewportSpec(params) {
  const name = String(params.device).toLowerCase();
  const preset = DEVICE_PRESETS[DEVICE_ALIASES[name] || name];
  let spec;
  if (preset) {
    spec = preset();
  } else {
    const m = name.match(/^(\d{2,5})x(\d{2,5})$/);
    if (!m) {
      throw new Error(`unknown viewport "${params.device}" — use iphone, android, ipad, <width>x<height> or reset`);
    }
    const mobile = params.mobile === true;
    spec = { label: `${m[1]}x${m[2]}`, width: Number(m[1]), height: Number(m[2]), dpr: mobile ? 3 : 0, mobile, touch: mobile };
  }
  if (params.dpr != null) {
    const dpr = Number(params.dpr);
    if (!(dpr > 0 && dpr <= 10)) throw new Error('--dpr must be a number between 0 and 10');
    spec.dpr = dpr;
  }
  if (params.landscape) [spec.width, spec.height] = [spec.height, spec.width];
  if (typeof params.ua === 'string' && params.ua) { spec.userAgent = params.ua; delete spec.metadata; }
  return spec;
}

async function measureViewport(tabId) {
  const res = await cdp(tabId, 'Runtime.evaluate', {
    expression: '({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, touch: navigator.maxTouchPoints > 0 })',
    returnByValue: true,
  }).catch(() => null);
  return res?.result?.value || null;
}

function send(tabId, method, params) {
  return chrome.debugger.sendCommand({ tabId }, method, params);
}

/** The device's User-Agent, or none. */
async function applyUserAgent(tabId, s) {
  const vp = s.overrides.viewport;
  if (!vp?.userAgent) {
    await send(tabId, 'Emulation.setUserAgentOverride', { userAgent: '' }).catch(() => {});
    return;
  }
  await send(tabId, 'Emulation.setUserAgentOverride', {
    userAgent: vp.userAgent,
    ...(vp.platform ? { platform: vp.platform } : {}),
    ...(vp.metadata ? { userAgentMetadata: vp.metadata } : {}),
  });
}

async function applyMedia(tabId, s) {
  const m = s.overrides.media || {};
  const features = [];
  if (m.colorScheme) features.push({ name: 'prefers-color-scheme', value: m.colorScheme });
  if (m.reducedMotion) features.push({ name: 'prefers-reduced-motion', value: 'reduce' });
  await send(tabId, 'Emulation.setEmulatedMedia', { media: m.type || '', features });
}

function overridesView(s) {
  const o = s.overrides;
  const out = {};
  if (o.viewport) out.viewport = `${o.viewport.device} ${o.viewport.width}x${o.viewport.height}`;
  if (o.media?.colorScheme) out.theme = o.media.colorScheme;
  if (o.media?.reducedMotion) out.reducedMotion = true;
  if (o.media?.type) out.media = o.media.type;
  if (o.network) out.network = o.network.label;
  if (o.cpu) out.cpu = `${o.cpu}x slower`;
  if (o.block) out.block = o.block;
  return out;
}

export async function viewportCommand(t, params) {
  const s = session(t.tabId);
  const device = params.device;
  if (!device) {
    const vp = s.overrides.viewport;
    return vp
      ? { emulated: true, ...publicViewport(vp), actual: await measureViewport(t.tabId) }
      : { emulated: false };
  }
  if (device === 'reset' || device === 'desktop') {
    const was = !!s.overrides.viewport;
    if (was && s.attached) {
      await send(t.tabId, 'Emulation.clearDeviceMetricsOverride').catch(() => {});
      await send(t.tabId, 'Emulation.setTouchEmulationEnabled', { enabled: false }).catch(() => {});
      delete s.overrides.viewport;
      await applyUserAgent(t.tabId, s);
    }
    delete s.overrides.viewport;
    touch(t.tabId);
    if (was && params.reload) await chrome.tabs.reload(t.tabId);
    return { emulated: false, reset: was, reloaded: !!(was && params.reload) };
  }

  const spec = viewportSpec(params);
  await attach(t.tabId);
  clearTimeout(s.idleTimer);
  await send(t.tabId, 'Emulation.setDeviceMetricsOverride', {
    width: spec.width, height: spec.height, deviceScaleFactor: spec.dpr, mobile: spec.mobile,
    screenWidth: spec.width, screenHeight: spec.height,
    screenOrientation: spec.width > spec.height
      ? { type: 'landscapePrimary', angle: 90 }
      : { type: 'portraitPrimary', angle: 0 },
  });
  await send(t.tabId, 'Emulation.setTouchEmulationEnabled', spec.touch ? { enabled: true, maxTouchPoints: 5 } : { enabled: false });
  s.overrides.viewport = {
    device: spec.label, width: spec.width, height: spec.height, dpr: spec.dpr || null,
    mobile: spec.mobile, touch: spec.touch,
    userAgent: spec.userAgent || null, platform: spec.platform || null, metadata: spec.metadata || null,
  };
  await applyUserAgent(t.tabId, s);

  // Layout and media queries follow at once; what a server decides from the
  // User-Agent (and touch detection done once at page load) needs a reload.
  if (params.reload) {
    await chrome.tabs.reload(t.tabId);
    await waitTabComplete(t.tabId, 15_000);
  }
  return { emulated: true, ...publicViewport(s.overrides.viewport), reloaded: !!params.reload, actual: await measureViewport(t.tabId) };
}

function publicViewport(vp) {
  const { platform, metadata, ...rest } = vp;
  return rest;
}

/** `theme dark|light|reset` — the real prefers-color-scheme, not a class on <html>. */
export async function themeCommand(t, params) {
  const mode = params.mode;
  if (!['dark', 'light', 'reset', 'auto'].includes(mode)) throw new Error('theme --mode must be dark, light or reset');
  const s = await attach(t.tabId);
  const media = { ...(s.overrides.media || {}) };
  if (mode === 'reset' || mode === 'auto') delete media.colorScheme; else media.colorScheme = mode;
  if (Object.keys(media).length) s.overrides.media = media; else delete s.overrides.media;
  await applyMedia(t.tabId, s);
  touch(t.tabId);
  const matches = await cdp(t.tabId, 'Runtime.evaluate', {
    expression: 'matchMedia("(prefers-color-scheme: dark)").matches', returnByValue: true,
  }).catch(() => null);
  return { theme: mode === 'auto' ? 'reset' : mode, pageSeesDark: matches?.result?.value ?? null, ...(s.overrides.media ? { stays: 'until theme reset' } : {}) };
}

const NETWORK_PRESETS = {
  offline: { label: 'offline', offline: true, latency: 0, downloadThroughput: 0, uploadThroughput: 0 },
  'slow-3g': { label: 'slow 3G', offline: false, latency: 2000, downloadThroughput: 50_000, uploadThroughput: 50_000 },
  'fast-3g': { label: 'fast 3G', offline: false, latency: 563, downloadThroughput: 180_000, uploadThroughput: 84_375 },
  'slow-4g': { label: 'slow 4G', offline: false, latency: 150, downloadThroughput: 200_000, uploadThroughput: 200_000 },
};

const OFF = new Set(['off', 'none', 'reset', 'false']);

/**
 * `emulate [--network P] [--cpu N] [--block P,…]
 *          [--media print|screen] [--reduced-motion on|off]`, `emulate reset`,
 * or no flags to show what is on.
 */
export async function emulateCommand(t, params) {
  const s = session(t.tabId);
  if (params.timezone !== undefined || params.locale !== undefined) {
    // Chrome answers "only available to trusted clients": extensions may not
    // override them (a local CDP client such as Playwright can).
    throw new Error('Chrome does not let extensions emulate a timezone or locale. Test those with a headless browser (e.g. Playwright) instead.');
  }
  const keys = ['network', 'cpu', 'block', 'media', 'reducedMotion'];
  const all = params.op === 'reset';
  if (!all && !keys.some((k) => params[k] !== undefined)) return { on: overridesView(s) };
  await attach(t.tabId);
  clearTimeout(s.idleTimer);
  const o = s.overrides;
  const val = (k) => (all ? 'off' : params[k]);
  const isOff = (v) => v === false || OFF.has(String(v).toLowerCase());

  if (all || params.network !== undefined) {
    const v = val('network');
    if (isOff(v)) {
      if (o.network) await send(t.tabId, 'Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }).catch(() => {});
      delete o.network;
    } else {
      const p = NETWORK_PRESETS[String(v).toLowerCase()];
      if (!p) throw new Error(`--network takes ${Object.keys(NETWORK_PRESETS).join(', ')} or off`);
      await send(t.tabId, 'Network.enable');
      const { label, ...cond } = p;
      await send(t.tabId, 'Network.emulateNetworkConditions', cond);
      o.network = { label };
    }
  }
  if (all || params.block !== undefined) {
    const v = val('block');
    if (isOff(v)) {
      if (o.block) await send(t.tabId, 'Network.setBlockedURLs', { urls: [] }).catch(() => {});
      delete o.block;
    } else {
      const urls = String(v).split(',').map((u) => u.trim()).filter(Boolean);
      await send(t.tabId, 'Network.enable');
      await send(t.tabId, 'Network.setBlockedURLs', { urls });
      o.block = urls;
    }
  }
  if (!o.network && !o.block && !s.capture && (all || params.network !== undefined || params.block !== undefined)) {
    await send(t.tabId, 'Network.disable').catch(() => {});
  }
  if (all || params.cpu !== undefined) {
    const v = val('cpu');
    if (isOff(v) || Number(v) === 1) {
      if (o.cpu) await send(t.tabId, 'Emulation.setCPUThrottlingRate', { rate: 1 }).catch(() => {});
      delete o.cpu;
    } else {
      const rate = Number(v);
      if (!(rate > 1 && rate <= 20)) throw new Error('--cpu takes a slowdown factor from 2 to 20 (e.g. 4), or off');
      await send(t.tabId, 'Emulation.setCPUThrottlingRate', { rate });
      o.cpu = rate;
    }
  }
  if (all || params.media !== undefined || params.reducedMotion !== undefined) {
    const media = { ...(o.media || {}) };
    if (all) { delete media.type; delete media.reducedMotion; }
    if (params.media !== undefined && !all) {
      const v = String(params.media).toLowerCase();
      if (isOff(v) || v === 'screen') delete media.type;
      else if (v === 'print') media.type = 'print';
      else throw new Error('--media takes print or screen');
    }
    if (params.reducedMotion !== undefined && !all) {
      if (isOff(params.reducedMotion)) delete media.reducedMotion; else media.reducedMotion = true;
    }
    if (Object.keys(media).length) o.media = media; else delete o.media;
    await applyMedia(t.tabId, s);
  }
  touch(t.tabId);
  return { on: overridesView(s) };
}

function waitTabComplete(tabId, ms) {
  return new Promise((resolve) => {
    const done = () => { clearTimeout(timer); chrome.tabs.onUpdated.removeListener(onUpdated); resolve(); };
    const onUpdated = (id, info) => { if (id === tabId && info.status === 'complete') done(); };
    const timer = setTimeout(done, ms);
    chrome.tabs.onUpdated.addListener(onUpdated);
  });
}

export { hasOverrides };
