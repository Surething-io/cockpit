/**
 * OpenCockpit Bridge — page automation core (classic script, ISOLATED world).
 *
 * Injected on demand by the service worker via chrome.scripting into exactly
 * one frame: a Cockpit browser bubble, or a Chrome tab the user shared / that
 * Cockpit opened. It builds the a11y tree, resolves refs, and performs DOM
 * operations. It has NO message listener: the only entry point is
 * `globalThis.__cockpitCore.run(action, params)`, which the service worker
 * calls through chrome.scripting.executeScript. A page cannot reach it.
 *
 * State (refs, snapshot epoch, recording) lives in the extension's isolated
 * world for the lifetime of the document, so it survives between commands.
 *
 * Console / network data:
 *   - bubbles: pulled from bubble-hook.js (MAIN world) over CustomEvents;
 *   - tabs: captured by the service worker over CDP and passed in as
 *     `params.__capture` (null when capture is not running).
 */
(function () {
'use strict';
if (globalThis.__cockpitCore) return;

const LOG_PREFIX = '[Cockpit Automation]';

// ============================================================================
// Ref system: assigns stable ref IDs to elements in the a11y tree
// ============================================================================

let refCounter = 0;
const refToElement = new Map();
const elementToRef = new WeakMap();

// Snapshot epoch: incremented by clearRefs() each time `snapshot` runs.
// Refs encode the epoch as `e<N>#v<E>`, so stale refs from a previous
// snapshot are detected explicitly rather than producing a misleading
// "disconnected" message.
let snapshotEpoch = 0;

function clearRefs() {
  refCounter = 0;
  refToElement.clear();
  snapshotEpoch += 1;
}

function assignRef(el) {
  // WeakMap can't be cleared, so a previously-snapshotted element returns its
  // OLD ref (carrying an old epoch). Detect that and re-assign at the current
  // epoch so all refs in a single snapshot share one banner version.
  const existing = elementToRef.get(el);
  if (existing) {
    const m = existing.match(/^e\d+#v(\d+)$/);
    if (m && Number(m[1]) === snapshotEpoch) return existing;
    // fall through — re-assign at the current epoch
  }
  const ref = `e${refCounter++}#v${snapshotEpoch}`;
  refToElement.set(ref, el);
  elementToRef.set(el, ref);
  return ref;
}

// Inline stale-ref message — kept here (not in messages.js) to avoid
// runtime cross-module loading in the content-script context. Examples
// below are generic by policy; never inline business-specific selectors.
function staleRefMsg(ref, kind, currentEpoch) {
  return (
    `Element ref "${ref}" is stale (current snapshot v=${currentEpoch}; kind: ${kind}).\n` +
    `  Refs are valid only until the next snapshot / re-render / route change.\n` +
    `  Fix one of:\n` +
    `    1. Re-run \`snapshot\` to get fresh refs (banner shows v=${currentEpoch}).\n` +
    `    2. Use a CSS selector or visible text directly:\n` +
    `       cockpit browser <id> click --text "Sign in"\n` +
    `       cockpit browser <id> click --selector 'button[type="submit"]'\n` +
    `    3. Drop to evaluate:\n` +
    `       cockpit browser <id> evaluate "(() => document.querySelector('button[aria-label=\\"Save\\"]').click())()"`
  );
}

function findByRef(ref) {
  if (typeof ref !== 'string' || !ref) {
    throw new Error(staleRefMsg(String(ref), 'missing', snapshotEpoch));
  }
  const m = ref.match(/^e(\d+)(?:#v(\d+))?$/);
  if (!m) {
    throw new Error(staleRefMsg(ref, 'malformed', snapshotEpoch));
  }
  if (m[2] === undefined) {
    // Legacy `eN` form (no epoch). Per spec there is no backwards compat;
    // reject explicitly so AI knows to re-snapshot rather than guessing.
    throw new Error(staleRefMsg(ref, 'no-epoch (use eN#vM)', snapshotEpoch));
  }
  const refEpoch = Number(m[2]);
  if (refEpoch !== snapshotEpoch) {
    throw new Error(staleRefMsg(ref, `from v=${refEpoch}`, snapshotEpoch));
  }
  const el = refToElement.get(ref);
  if (!el || !el.isConnected) {
    throw new Error(staleRefMsg(ref, 'disconnected', snapshotEpoch));
  }
  return el;
}

// ============================================================================
// A11y Tree construction
// ============================================================================

const IMPLICIT_ROLES = {
  A: (el) => el.hasAttribute('href') ? 'link' : null,
  ARTICLE: () => 'article',
  ASIDE: () => 'complementary',
  BUTTON: () => 'button',
  DETAILS: () => 'group',
  DIALOG: () => 'dialog',
  FOOTER: () => 'contentinfo',
  FORM: () => 'form',
  H1: () => 'heading', H2: () => 'heading', H3: () => 'heading',
  H4: () => 'heading', H5: () => 'heading', H6: () => 'heading',
  HEADER: () => 'banner',
  HR: () => 'separator',
  IMG: () => 'img',
  INPUT: (el) => {
    const t = (el.type || 'text').toLowerCase();
    if (t === 'checkbox') return 'checkbox';
    if (t === 'radio') return 'radio';
    if (t === 'range') return 'slider';
    if (t === 'search') return 'searchbox';
    if (t === 'submit' || t === 'reset' || t === 'button' || t === 'image') return 'button';
    return 'textbox';
  },
  LI: () => 'listitem',
  MAIN: () => 'main',
  NAV: () => 'navigation',
  OL: () => 'list',
  OPTION: () => 'option',
  PROGRESS: () => 'progressbar',
  SECTION: (el) => el.hasAttribute('aria-label') || el.hasAttribute('aria-labelledby') ? 'region' : null,
  SELECT: () => 'combobox',
  TABLE: () => 'table',
  TBODY: () => 'rowgroup',
  TD: () => 'cell',
  TEXTAREA: () => 'textbox',
  TH: () => 'columnheader',
  THEAD: () => 'rowgroup',
  TR: () => 'row',
  UL: () => 'list',
};

const SKIP_TAGS = new Set(['SCRIPT', 'STYLE', 'NOSCRIPT', 'SVG', 'TEMPLATE', 'LINK', 'META']);

function isVisible(el) {
  if (el.hidden) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  const style = getComputedStyle(el);
  if (style.display === 'none' || style.visibility === 'hidden') return false;
  return true;
}

function getRole(el) {
  const explicit = el.getAttribute('role');
  if (explicit) return explicit;
  const fn = IMPLICIT_ROLES[el.tagName];
  return fn ? fn(el) : null;
}

function getName(el) {
  const ariaLabel = el.getAttribute('aria-label');
  if (ariaLabel) return ariaLabel.trim();

  const labelledBy = el.getAttribute('aria-labelledby');
  if (labelledBy) {
    const parts = labelledBy.split(/\s+/).map(id => {
      const ref = document.getElementById(id);
      return ref ? ref.textContent?.trim() : '';
    }).filter(Boolean);
    if (parts.length) return parts.join(' ');
  }

  const tag = el.tagName;
  if (tag === 'IMG') return el.alt || '';
  if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') {
    if (el.id) {
      const label = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (label) return label.textContent?.trim() || '';
    }
    return el.placeholder || el.title || '';
  }
  if (tag === 'A') return el.textContent?.trim() || '';

  const role = getRole(el);
  if (role === 'button' || role === 'heading' || role === 'link' || role === 'tab' || role === 'menuitem') {
    return el.textContent?.trim() || '';
  }

  return el.title || '';
}

function buildA11yTree(root = document.body, opts = {}) {
  const {
    maxDepth = 12,
    filter = null,           // string regex source; lines not matching are dropped
    includeHiddenText = false, // surface innerText for container/anonymous nodes
  } = opts;

  clearRefs();
  const lines = [];
  const filterRe = filter ? safeRegex(filter) : null;

  function walk(el, depth) {
    if (depth > maxDepth) return;
    if (!(el instanceof HTMLElement)) return;
    if (SKIP_TAGS.has(el.tagName)) return;
    if (!isVisible(el)) return;

    const role = getRole(el);
    const name = getName(el);
    const ref = assignRef(el);
    const isContainer = !role && !name && (el.tagName === 'DIV' || el.tagName === 'SPAN' || el.tagName === 'SECTION');

    if (!isContainer) {
      const indent = '  '.repeat(depth);
      let line = indent;
      line += role || el.tagName.toLowerCase();

      if (name) {
        const displayName = name.length > 80 ? name.slice(0, 77) + '...' : name;
        line += ` "${displayName}"`;
      } else if (includeHiddenText) {
        // Surface collapsed text on otherwise-nameless nodes (e.g. <summary>,
        // <details>, headings with emoji + text). Useful when grep-ing on
        // user-visible content rather than role+aria-label.
        const inner = (el.innerText || '').trim().replace(/\s+/g, ' ');
        if (inner) {
          const snippet = inner.length > 60 ? inner.slice(0, 57) + '...' : inner;
          line += ` …"${snippet}"`;
        }
      }

      const extras = [];
      if (el.tagName.match(/^H[1-6]$/)) extras.push(`level=${el.tagName[1]}`);
      if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox' || el.type === 'radio') extras.push(el.checked ? 'checked' : 'unchecked');
        if (el.disabled) extras.push('disabled');
        if (el.value) extras.push(`value="${el.value.slice(0, 30)}"`);
      }
      if (el instanceof HTMLSelectElement && el.value) extras.push(`value="${el.value}"`);
      if (el instanceof HTMLInputElement && el.type === 'file') extras.push(el.multiple ? 'file, multiple' : 'file');
      if (el instanceof HTMLIFrameElement && el.src) {
        try { extras.push(`src=${new URL(el.src, location.href).host || el.src.slice(0, 40)}`); } catch { /* odd src */ }
      }
      if (el.getAttribute('aria-expanded')) extras.push(`expanded=${el.getAttribute('aria-expanded')}`);
      if (el.getAttribute('aria-selected') === 'true') extras.push('selected');
      if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) extras.push('disabled');

      if (extras.length) line += ` [${extras.join(', ')}]`;
      line += ` [${ref}]`;
      lines.push(line);
    } else if (includeHiddenText) {
      // Even for "container" passthrough, emit a thin marker line if it has
      // visible text — so grep can still find content collapsed by the
      // container heuristic. We don't assign a ref here (container is just
      // structure, not addressable).
      const inner = (el.innerText || '').trim().replace(/\s+/g, ' ');
      if (inner) {
        const indent = '  '.repeat(depth);
        const snippet = inner.length > 60 ? inner.slice(0, 57) + '...' : inner;
        lines.push(`${indent}${el.tagName.toLowerCase()} …"${snippet}"`);
      }
    }

    for (const child of el.children) {
      walk(child, isContainer ? depth : depth + 1);
    }
    // Open shadow roots are part of what the user sees (web components).
    if (el.shadowRoot) {
      for (const child of el.shadowRoot.children) {
        walk(child, isContainer ? depth : depth + 1);
      }
    }
  }

  walk(root || document.body, 0);

  let kept = lines;
  if (filterRe) kept = lines.filter(l => filterRe.test(l));

  // Banner is always emitted first. AI parses v=<N> to detect epoch changes
  // (any cached refs from a different epoch are stale per findByRef).
  const banner = (
    `# a11y tree v=${snapshotEpoch} — refs valid until next snapshot\n` +
    `# Text inside <details>/<summary> and unnamed container <div>/<section> is collapsed.\n` +
    `# Grep on role / aria-label, NOT on user-visible emoji / text.\n` +
    `# Tips: --include-hidden-text surfaces collapsed innerText; --filter <regex> reduces output.\n` +
    (filterRe ? `# filter: ${filter} (${kept.length}/${lines.length} lines kept)\n` : '') +
    (includeHiddenText ? `# include-hidden-text: on\n` : '')
  );
  return banner + kept.join('\n');
}

// Safe regex compile — falls back to a literal-match regex if the pattern
// is malformed, so a stray `?` or `(` from AI doesn't crash the snapshot.
function safeRegex(src) {
  try { return new RegExp(src); }
  catch { return new RegExp(src.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')); }
}

// ============================================================================
// Console interception
// ============================================================================

const consoleBuffer = [];
const networkBuffer = [];

// 'hook' (bubble), 'external' (tab, CDP capture running) or 'none' (tab, no capture)
let captureSource = 'hook';

function replaceArray(target, items) {
  target.length = 0;
  for (const item of items || []) target.push(item);
}

/** Pull the latest console/network snapshot before reading the buffers. */
function refreshBuffers() {
  if (captureSource !== 'hook') return;
  let snapshot = null;
  const onSync = (e) => {
    try { snapshot = JSON.parse(e.detail); } catch { /* ignore */ }
  };
  window.addEventListener('cockpit:hook-sync', onSync);
  try {
    window.dispatchEvent(new CustomEvent('cockpit:hook-pull'));
  } finally {
    window.removeEventListener('cockpit:hook-sync', onSync);
  }
  if (snapshot) {
    replaceArray(consoleBuffer, snapshot.console);
    replaceArray(networkBuffer, snapshot.network);
  }
}

function requireCapture(what) {
  if (captureSource === 'none') {
    throw new Error(
      `${what} needs console/network capture, which is not running on this tab.\n` +
      `  Start it first:  cockpit browser <id> network_record start   (or run \`console\` once)\n` +
      `  Capture only sees activity after it starts — reload the page if you need the initial load.`
    );
  }
}

// ============================================================================
// Network recording state (body capture is done by bubble-hook.js)
// ============================================================================

const networkRecording = {
  active: false,
  filters: {},   // { url, method, status }
  timer: null,   // auto-expiry timer
  startedAt: 0,
};

function clearAllBodies() {
  window.dispatchEvent(new CustomEvent('cockpit:hook-clear-bodies'));
}

function syncRecordingToMainWorld() {
  window.dispatchEvent(new CustomEvent('cockpit:hook-recording', {
    detail: JSON.stringify({ active: networkRecording.active, filters: networkRecording.filters }),
  }));
}

/** Laid out and not hidden by CSS — something a person could actually click. */
function isRendered(el) {
  const r = el.getBoundingClientRect();
  if (r.width === 0 && r.height === 0) return false;
  if (typeof el.checkVisibility === 'function') return el.checkVisibility({ visibilityProperty: true });
  return el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
}

/**
 * Pick the nth match among the VISIBLE ones: responsive pages often carry a
 * hidden twin (mobile menu, template copy) ahead of the element on screen.
 * `includeHidden` is for targets that are legitimately hidden (file inputs).
 */
function pickVisible(all, nth, what, includeHidden) {
  const pool = includeHidden ? all : all.filter(isRendered);
  if (!pool.length) {
    throw new Error(`${all.length} match${all.length > 1 ? 'es' : ''} for ${what}, but none is visible (hidden by CSS or zero-size). ` +
      'Open whatever reveals it first, or pick it from a fresh snapshot.');
  }
  if (nth >= pool.length) {
    const hidden = all.length - pool.length;
    throw new Error(`Only ${pool.length} visible match${pool.length > 1 ? 'es' : ''} for ${what}${hidden ? ` (${hidden} hidden skipped)` : ''}, nth=${nth} out of range`);
  }
  return pool[nth];
}

function resolveClickTarget({ ref, text, selector, exact = false, nth = 0, includeHidden = false }) {
  if (ref) return findByRef(ref);
  if (selector) {
    const all = Array.from(document.querySelectorAll(selector));
    if (!all.length) throw new Error(`No element matching selector "${selector}"`);
    return pickVisible(all, nth, `selector "${selector}"`, includeHidden);
  }
  if (text) {
    const candidates = Array.from(document.querySelectorAll(
      'button, a, [role="button"], [role="link"], [role="tab"], [role="menuitem"], input[type="submit"], input[type="button"]'
    ));
    const matches = candidates.filter(c => {
      const t = (c.textContent || '').trim();
      const aria = c.getAttribute('aria-label') || '';
      return exact ? (t === text || aria === text) : (t.includes(text) || aria.includes(text));
    });
    if (!matches.length) throw new Error(`No clickable element with text "${text}" (searched button / a / role=button|link|tab|menuitem / input[type=submit|button])`);
    return pickVisible(matches, nth, `text "${text}"`, includeHidden);
  }
  throw new Error('click requires one of: ref (positional or --ref), --text, --selector');
}

/**
 * `--at X,Y`: a point inside the element, from its top-left corner, in CSS
 * pixels or percent ("20,30", "50%,50%"). For targets with no child to aim at:
 * canvas, maps, charts, image hotspots.
 */
function pointInElement(r, at, label) {
  const parts = String(at).split(',').map((p) => p.trim());
  if (parts.length !== 2) throw new Error(`--at takes X,Y (e.g. 20,30 or 50%,50%), got "${at}"`);
  const coord = (p, size) => {
    const m = p.match(/^(\d+(?:\.\d+)?)(%?)$/);
    if (!m) throw new Error(`--at takes X,Y (e.g. 20,30 or 50%,50%), got "${at}"`);
    return m[2] ? (Number(m[1]) / 100) * size : Number(m[1]);
  };
  const dx = coord(parts[0], r.width);
  const dy = coord(parts[1], r.height);
  if (dx > r.width || dy > r.height) {
    throw new Error(`--at ${at} is outside ${label}, which is ${Math.round(r.width)}x${Math.round(r.height)}`);
  }
  return { x: r.left + dx, y: r.top + dy };
}

// ============================================================================
// Command handlers
// ============================================================================

const handlers = {
  navigate: async ({ url }) => {
    window.location.href = url;
    return { navigating: true, url };
  },
  url: async () => window.location.href,
  title: async () => document.title,
  reload: async ({ noCache }) => { window.location.reload(noCache); return { reloading: true }; },
  back: async () => { history.back(); return { ok: true }; },
  forward: async () => { history.forward(); return { ok: true }; },

  snapshot: async ({ filter, includeHiddenText, maxDepth } = {}) =>
    buildA11yTree(document.body, { filter, includeHiddenText, maxDepth }),

  click: async ({ ref, text, selector, exact = false, nth = 0, at }) => {
    const el = resolveClickTarget({ ref, text, selector, exact, nth });
    el.scrollIntoView({ block: 'nearest' });
    const label = ref || (text ? `text:${text}` : `selector:${selector}`);
    if (at == null) {
      el.click();
      return { clicked: label, nth };
    }
    // Synthetic events at the point, on whatever is drawn there.
    const { x, y } = pointInElement(el.getBoundingClientRect(), at, label);
    const target = document.elementFromPoint(x, y) || el;
    const init = { bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, button: 0, view: window };
    target.dispatchEvent(new PointerEvent('pointerdown', { ...init, pointerId: 1, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mousedown', init));
    target.dispatchEvent(new PointerEvent('pointerup', { ...init, pointerId: 1, isPrimary: true }));
    target.dispatchEvent(new MouseEvent('mouseup', init));
    target.dispatchEvent(new MouseEvent('click', init));
    return { clicked: label, nth, at };
  },

  // Internal — trusted-input support for tabs. Resolves the same targets as
  // click / type, scrolls the element into view and returns its centre in
  // top-level viewport CSS pixels (the service worker then dispatches real
  // input over CDP). Tabs only run the core in their top frame, so the
  // element's own viewport is the tab's viewport.
  _locate: async ({ ref, text, selector, exact = false, nth = 0, focus = false, clear = false, noScroll = false, at }) => {
    const el = resolveClickTarget({ ref, text, selector, exact, nth });
    if (!noScroll) el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) {
      throw new Error(`Element ${ref || selector || text} has no layout box (hidden?); try --dom or evaluate`);
    }
    if (focus) el.focus();
    if (clear && 'value' in el) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, ''); else el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    const label = ref || (text ? `text:${text}` : `selector:${selector}`);
    const point = at != null ? pointInElement(r, at, label) : { x: r.left + r.width / 2, y: r.top + r.height / 2 };
    return {
      x: point.x,
      y: point.y,
      left: r.left, top: r.top, width: r.width, height: r.height,
      inView: r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth,
      tag: el.tagName.toLowerCase(),
      label: ref || (text ? `text:${text}` : `selector:${selector}`),
    };
  },

  // Tag an element so CDP can find it (DOM.setFileInputFiles, event
  // listeners need a remote object). Works on hidden elements too: a file
  // input is usually display:none behind a styled button.
  _mark: async ({ ref, text, selector, exact = false, nth = 0 }) => {
    const el = resolveClickTarget({ ref, text, selector, exact, nth, includeHidden: true });
    const nonce = `m${Math.random().toString(36).slice(2)}`;
    el.setAttribute('data-cockpit-mark', nonce);
    return {
      nonce,
      tag: el.tagName.toLowerCase(),
      type: el instanceof HTMLInputElement ? el.type : null,
      multiple: el instanceof HTMLInputElement ? el.multiple : false,
      label: ref || (text ? `text:${text}` : `selector:${selector}`),
    };
  },

  _unmark: async ({ nonce }) => {
    document.querySelector(`[data-cockpit-mark="${nonce}"]`)?.removeAttribute('data-cockpit-mark');
    return true;
  },

  // Which <iframe> in this document is the child frame that posts `nonce`?
  // The extension cannot map a frame id to its owner element, but the owner's
  // contentWindow IS the message source — same check across origins.
  _frameOwner: async ({ nonce, timeout = 1500 }) => new Promise((resolve) => {
    const done = (v) => { clearTimeout(timer); removeEventListener('message', onMsg, true); resolve(v); };
    const onMsg = (e) => {
      if (!e.data || e.data.__cockpitFrameProbe !== nonce) return;
      e.stopImmediatePropagation();
      const frames = [];
      const collect = (root) => {
        for (const f of root.querySelectorAll('iframe, frame')) frames.push(f);
        for (const host of root.querySelectorAll('*')) if (host.shadowRoot) collect(host.shadowRoot);
      };
      collect(document);
      const el = frames.find((f) => f.contentWindow === e.source);
      if (!el) return done(null);
      const r = el.getBoundingClientRect();
      const cs = getComputedStyle(el);
      const ref = elementToRef.get(el);
      done({
        ref: ref && Number(ref.split('#v')[1]) === snapshotEpoch ? ref : null,
        x: r.left + el.clientLeft + parseFloat(cs.paddingLeft || '0'),
        y: r.top + el.clientTop + parseFloat(cs.paddingTop || '0'),
        width: el.clientWidth, height: el.clientHeight,
      });
    };
    addEventListener('message', onMsg, true);
    const timer = setTimeout(() => done(null), timeout);
  }),

  _frameProbe: async ({ nonce }) => {
    // A few sends: the parent's listener may still be on its way in.
    for (const ms of [0, 60, 180, 400, 800]) {
      setTimeout(() => parent.postMessage({ __cockpitFrameProbe: nonce }, '*'), ms);
    }
    return true;
  },

  type: async ({ ref, text, clear }) => {
    const el = findByRef(ref);
    el.focus();
    if (clear && 'value' in el) {
      el.value = '';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    }
    for (const char of text) {
      el.dispatchEvent(new KeyboardEvent('keydown', { key: char, bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keypress', { key: char, bubbles: true }));
      if ('value' in el) {
        const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
          || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
        if (setter) setter.call(el, el.value + char);
        else el.value += char;
      }
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new KeyboardEvent('keyup', { key: char, bubbles: true }));
    }
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { typed: text, ref };
  },

  fill: async ({ ref, selector, value }) => {
    let el;
    let target;
    if (ref) {
      el = findByRef(ref);
      target = ref;
    } else if (selector) {
      el = document.querySelector(selector);
      if (!el) throw new Error(`No element matching selector "${selector}"`);
      target = `selector:${selector}`;
    } else {
      throw new Error('fill requires one of: ref (positional or --ref), --selector');
    }
    el.focus();
    if (el.tagName === 'SELECT') {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: target, value };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: target, value };
  },

  hover: async ({ ref }) => {
    const el = findByRef(ref);
    el.scrollIntoView({ block: 'nearest' });
    el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
    el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
    return { hovered: ref };
  },

  focus: async ({ ref }) => { findByRef(ref).focus(); return { focused: ref }; },

  scroll: async ({ ref, direction, amount = 300 }) => {
    const target = ref ? findByRef(ref) : window;
    const opts = { behavior: 'instant' };
    if (direction === 'up') opts.top = -amount;
    else if (direction === 'down') opts.top = amount;
    else if (direction === 'left') opts.left = -amount;
    else if (direction === 'right') opts.left = amount;
    (target === window ? window : target).scrollBy(opts);
    return { scrolled: direction, amount };
  },

  key: async ({ key }) => {
    const parts = key.split('+');
    const mainKey = parts.pop();
    const mods = {
      ctrlKey: parts.includes('Control') || parts.includes('Ctrl'),
      shiftKey: parts.includes('Shift'),
      altKey: parts.includes('Alt'),
      metaKey: parts.includes('Meta') || parts.includes('Cmd'),
    };
    const opts = { key: mainKey, bubbles: true, ...mods };
    document.activeElement.dispatchEvent(new KeyboardEvent('keydown', opts));
    document.activeElement.dispatchEvent(new KeyboardEvent('keyup', opts));
    return { pressed: key };
  },

  dispatch: async ({ ref, event, detail }) => {
    const el = findByRef(ref);
    const opts = { bubbles: true, ...(detail || {}) };
    if (event.startsWith('mouse') || event === 'click' || event === 'dblclick') {
      el.dispatchEvent(new MouseEvent(event, opts));
    } else if (event.startsWith('key')) {
      el.dispatchEvent(new KeyboardEvent(event, opts));
    } else {
      el.dispatchEvent(new Event(event, opts));
    }
    return { dispatched: event, ref };
  },

  wait: async ({
    text,
    ref: waitRef,
    url: waitUrl,
    time,
    selector,
    state = 'visible',
    networkIdle,
    domStable,
    quietMs = 500,
    maxRequestAgeMs = 30000,
    timeout = 10000,
  }) => {
    const start = Date.now();
    const poll = (check) => new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        try {
          if (check()) { clearInterval(interval); resolve(true); return; }
        } catch (e) { clearInterval(interval); reject(e); return; }
        if (Date.now() - start > timeout) {
          clearInterval(interval);
          reject(new Error(`Wait timeout after ${timeout}ms`));
        }
      }, 100);
    });

    if (time) { await new Promise(r => setTimeout(r, time)); return { waited: `${time}ms` }; }

    if (text) {
      await poll(() => document.body.textContent.includes(text));
      return { waited: `text "${text}"`, elapsedMs: Date.now() - start };
    }

    if (waitRef) {
      await poll(() => refToElement.has(waitRef) && refToElement.get(waitRef).isConnected);
      return { waited: `ref ${waitRef}`, elapsedMs: Date.now() - start };
    }

    if (waitUrl) {
      const pat = waitUrl.includes('*') ? new RegExp('^' + waitUrl.replace(/\*/g, '.*') + '$') : null;
      await poll(() => pat ? pat.test(location.href) : location.href.includes(waitUrl));
      return { waited: `url "${waitUrl}"`, elapsedMs: Date.now() - start };
    }

    // F2.2 — wait for an element matching CSS selector to reach a state.
    if (selector) {
      const validStates = ['visible', 'hidden', 'attached', 'detached'];
      if (!validStates.includes(state)) {
        throw new Error(`Invalid --state "${state}"; expected one of: ${validStates.join(', ')}`);
      }
      await poll(() => {
        const el = document.querySelector(selector);
        if (state === 'attached') return !!el;
        if (state === 'detached') return !el;
        if (!el) return false;
        const vis = isVisible(el);
        return state === 'visible' ? vis : !vis;
      });
      return { waited: `selector "${selector}" → ${state}`, elapsedMs: Date.now() - start };
    }

    // F2.1 — wait for the page network to settle: 0 in-flight requests for
    // `quietMs` consecutive ms. Requests older than `maxRequestAgeMs` are
    // ignored (covers SSE / long-poll). Counts XHR + fetch from networkBuffer.
    if (networkIdle) {
      let quietSince = null;
      await poll(() => {
        refreshBuffers();
        const now = Date.now();
        const inflight = networkBuffer.filter(e =>
          e.status == null &&
          e.startTime &&
          (now - e.startTime) < maxRequestAgeMs
        ).length;
        if (inflight === 0) {
          if (quietSince == null) quietSince = now;
          return (now - quietSince) >= quietMs;
        }
        quietSince = null;
        return false;
      });
      return { waited: `network-idle (quiet=${quietMs}ms)`, elapsedMs: Date.now() - start };
    }

    // F3.3 — wait until DOM mutations stop for `quietMs` consecutive ms.
    if (domStable) {
      return await new Promise((resolve, reject) => {
        let lastMutation = Date.now();
        const obs = new MutationObserver(() => { lastMutation = Date.now(); });
        obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        const tick = setInterval(() => {
          const now = Date.now();
          if (now - lastMutation >= quietMs) {
            clearInterval(tick); obs.disconnect();
            resolve({ waited: `dom-stable (quiet=${quietMs}ms)`, elapsedMs: now - start });
            return;
          }
          if (now - start > timeout) {
            clearInterval(tick); obs.disconnect();
            reject(new Error(`Wait timeout after ${timeout}ms (dom still mutating)`));
          }
        }, 50);
      });
    }

    throw new Error('wait requires one of: --text, --ref, --url, --time, --selector, --network-idle, --dom-stable');
  },

  console: async ({ level, clear: doClear }) => {
    if (doClear) { consoleBuffer.length = 0; window.dispatchEvent(new CustomEvent('cockpit:hook-clear', { detail: 'console' })); return { cleared: true }; }
    return level ? consoleBuffer.filter(m => m.level === level) : [...consoleBuffer];
  },

  network: async ({ status, method: fm, type: ft, clear: doClear }) => {
    if (doClear) { networkBuffer.length = 0; window.dispatchEvent(new CustomEvent('cockpit:hook-clear', { detail: 'network' })); return { cleared: true }; }
    let filtered = [...networkBuffer];
    if (status) {
      const ranges = status.split(',').map(s => s.trim());
      filtered = filtered.filter(r => ranges.some(range => {
        if (range.endsWith('xx')) { const base = parseInt(range[0]) * 100; return r.status >= base && r.status < base + 100; }
        return r.status === parseInt(range);
      }));
    }
    if (fm) filtered = filtered.filter(r => r.method === fm.toUpperCase());
    if (ft) filtered = filtered.filter(r => r.type === ft);
    return filtered.map(r => ({
      id: r.id, method: r.method, url: r.url, status: r.status,
      duration: r.duration, type: r.type, size: r.responseSize,
      recorded: !!r.recorded,
    }));
  },

  network_detail: async ({ id, maxBody = 32000 }) => {
    const entry = networkBuffer.find(r => r.id === id);
    if (!entry) return { error: `Request #${id} not found` };
    if (!entry.recorded) return { error: `Request #${id} was not recorded. Use 'network_record start' to enable body capture.`, id: entry.id, method: entry.method, url: entry.url, status: entry.status };
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
  },

  // Recording control: start begins body capture, stop ends it, status shows state
  network_record: async ({ action = 'status', url, method, status, ttl = 600 }) => {
    if (action === 'start') {
      // Clear the old expiry timer
      if (networkRecording.timer) clearTimeout(networkRecording.timer);
      networkRecording.active = true;
      networkRecording.filters = {};
      if (url) networkRecording.filters.url = url;
      if (method) networkRecording.filters.method = method;
      if (status) networkRecording.filters.status = status;
      networkRecording.startedAt = Date.now();
      syncRecordingToMainWorld();
      // Auto-expire after ttl seconds (default 10 minutes)
      networkRecording.timer = setTimeout(() => {
        networkRecording.active = false;
        clearAllBodies();
        networkRecording.timer = null;
        syncRecordingToMainWorld();
      }, ttl * 1000);
      return {
        recording: true,
        filters: networkRecording.filters,
        expiresIn: `${ttl}s`,
      };
    }
    if (action === 'stop') {
      networkRecording.active = false;
      if (networkRecording.timer) { clearTimeout(networkRecording.timer); networkRecording.timer = null; }
      syncRecordingToMainWorld();
      // Don't clear bodies immediately after stopping; allow querying the recorded data
      return { recording: false, recordedCount: networkBuffer.filter(r => r.recorded).length };
    }
    // status
    return {
      recording: networkRecording.active,
      filters: networkRecording.filters,
      startedAt: networkRecording.startedAt || null,
      elapsed: networkRecording.startedAt ? `${Math.round((Date.now() - networkRecording.startedAt) / 1000)}s` : null,
      recordedCount: networkBuffer.filter(r => r.recorded).length,
      totalCount: networkBuffer.length,
    };
  },

  computed: async ({ ref, properties }) => {
    const el = findByRef(ref);
    const style = getComputedStyle(el);
    if (properties) {
      const result = {};
      for (const prop of properties) result[prop] = style.getPropertyValue(prop);
      return result;
    }
    const common = ['display','position','width','height','margin','padding','color','background-color','font-size','font-weight','border','overflow','z-index','opacity','visibility','flex-direction','justify-content','align-items','gap'];
    const result = {};
    for (const prop of common) {
      const val = style.getPropertyValue(prop);
      if (val && val !== 'none' && val !== 'normal' && val !== 'auto' && val !== '0px') result[prop] = val;
    }
    return result;
  },

  bounds: async ({ ref }) => {
    const r = findByRef(ref).getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), width: Math.round(r.width), height: Math.round(r.height), top: Math.round(r.top), right: Math.round(r.right), bottom: Math.round(r.bottom), left: Math.round(r.left) };
  },

  attrs: async ({ ref }) => {
    const el = findByRef(ref);
    const result = { tagName: el.tagName.toLowerCase() };
    for (const attr of el.attributes) result[attr.name] = attr.value;
    return result;
  },

  events: async ({ ref }) => {
    const el = findByRef(ref);
    const result = [];
    for (const key of Object.keys(el)) {
      if (key.startsWith('on') && el[key]) result.push(key.slice(2));
    }
    for (const key of Object.keys(el)) {
      if (key.startsWith('__reactEvents$') || key.startsWith('__reactFiber$')) {
        result.push('(React events detected)');
        break;
      }
    }
    return result;
  },

  theme: async ({ mode }) => {
    if (mode === 'dark') { document.documentElement.style.colorScheme = 'dark'; document.documentElement.classList.add('dark'); document.documentElement.classList.remove('light'); }
    else if (mode === 'light') { document.documentElement.style.colorScheme = 'light'; document.documentElement.classList.add('light'); document.documentElement.classList.remove('dark'); }
    return { theme: mode };
  },

  cookies: async () => document.cookie,

  storage: async ({ type = 'local' }) => {
    const store = type === 'session' ? sessionStorage : localStorage;
    const result = {};
    for (let i = 0; i < store.length; i++) { const key = store.key(i); result[key] = store.getItem(key); }
    return result;
  },

  assert: async (params) => {
    const failures = [];

    // F2.3 — selector-based element resolution. Either --ref OR --selector
    // can locate the element; if both given, --selector wins (more stable
    // across re-renders, more typical for E2E).
    const resolveEl = () => {
      if (params.selector) {
        const el = document.querySelector(params.selector);
        if (!el) throw new Error(`No element matching selector "${params.selector}"`);
        return el;
      }
      if (params.ref) return findByRef(params.ref);
      throw new Error('assert requires --ref or --selector for element-level checks');
    };

    const needsElement = params.visible !== undefined || params.text !== undefined ||
      params.checked !== undefined || params.disabled !== undefined ||
      params.attr !== undefined;
    let el = null;
    if (needsElement) {
      try { el = resolveEl(); }
      catch (e) { failures.push(e.message); }
    }

    if (el && params.visible !== undefined) {
      const vis = isVisible(el);
      if (params.visible && !vis) failures.push(`Element is not visible (${params.selector || params.ref})`);
      if (!params.visible && vis) failures.push(`Element is visible (${params.selector || params.ref})`);
    }
    if (el && params.text !== undefined) {
      const actual = el.textContent?.trim() || '';
      if (!actual.includes(params.text)) failures.push(`Expected text "${params.text}", got "${actual.slice(0, 100)}"`);
    }
    if (el && params.checked !== undefined) {
      if (el.checked !== params.checked) failures.push(`Expected checked=${params.checked}, got ${el.checked}`);
    }
    if (el && params.disabled !== undefined) {
      const d = el.disabled || el.getAttribute('aria-disabled') === 'true';
      if (d !== params.disabled) failures.push(`Expected disabled=${params.disabled}, got ${d}`);
    }
    if (el && params.attr !== undefined) {
      // --attr "key=value" — split on first '='
      const eq = params.attr.indexOf('=');
      if (eq < 0) failures.push(`--attr must be "key=value" form, got "${params.attr}"`);
      else {
        const k = params.attr.slice(0, eq).trim();
        const v = params.attr.slice(eq + 1);
        const got = el.getAttribute(k);
        if (got !== v) failures.push(`Expected attr ${k}="${v}", got ${got === null ? 'null' : `"${got}"`}`);
      }
    }

    if (params.url) {
      const pat = params.url.includes('*') ? new RegExp('^' + params.url.replace(/\*/g, '.*') + '$') : null;
      const m = pat ? pat.test(location.href) : location.href.includes(params.url);
      if (!m) failures.push(`URL "${location.href}" does not match "${params.url}"`);
    }
    if (params.title) {
      if (!document.title.includes(params.title)) failures.push(`Title "${document.title}" does not match "${params.title}"`);
    }
    if (params.consoleNoErrors) {
      const errs = consoleBuffer.filter(m => m.level === 'error');
      if (errs.length) failures.push(`Found ${errs.length} console errors: ${errs.map(e => e.text).join('; ').slice(0, 200)}`);
    }

    // F2.4 — assert a matching request occurred in networkBuffer.
    //   --network  --method M --url U --status S [--since <epoch ms>]
    // `--url` matches as a substring (or with `*` glob).
    // `--status` may be a literal int, "2xx", "4xx", etc.
    // `--since` filters to entries with startTime >= since.
    if (params.network) {
      const sinceMs = params.since ? Number(params.since) : 0;
      const urlPat = params.url
        ? (params.url.includes('*')
            ? new RegExp('^' + params.url.replace(/\*/g, '.*') + '$')
            : null)
        : null;
      const methodU = params.method ? params.method.toUpperCase() : null;
      const statusCheck = (s) => {
        if (params.status == null) return true;
        const want = String(params.status);
        if (/^\d+$/.test(want)) return s === Number(want);
        if (/^\dxx$/.test(want)) return s >= Number(want[0]) * 100 && s < (Number(want[0]) + 1) * 100;
        return false;
      };
      const matches = networkBuffer.filter(e =>
        (!sinceMs || (e.startTime || 0) >= sinceMs) &&
        (!methodU || e.method === methodU) &&
        (!params.url || (urlPat ? urlPat.test(e.url) : (e.url || '').includes(params.url))) &&
        statusCheck(e.status)
      );
      if (!matches.length) {
        const desc = [
          params.method ? `method=${params.method}` : null,
          params.url ? `url=${params.url}` : null,
          params.status != null ? `status=${params.status}` : null,
          sinceMs ? `since=${sinceMs}` : null,
        ].filter(Boolean).join(' ');
        failures.push(`No matching request in networkBuffer (${desc}); buffer has ${networkBuffer.length} entries`);
      }
    }

    // F2.5 — assert backend by fetch + jsonpath compare.
    //   --fetch <url> [--method M] [--body B] [--fetch-status N]
    //   [--jsonpath P --equals V | --contains V | --not-contains V]
    if (params.fetch) {
      const init = { method: params.fetchMethod || 'GET', credentials: 'same-origin' };
      init.headers = { 'Accept': 'application/json, text/plain, */*' };
      if (params.body != null) {
        init.body = typeof params.body === 'string' ? params.body : JSON.stringify(params.body);
        init.headers['Content-Type'] = 'application/json';
      }
      let r, data, parseErr;
      try {
        r = await fetch(params.fetch, init);
        const ct = r.headers.get('content-type') || '';
        data = ct.includes('json') ? await r.json().catch(() => r.text()) : await r.text();
      } catch (e) { parseErr = e.message; }
      if (parseErr) {
        failures.push(`assert --fetch ${params.fetch}: ${parseErr}`);
      } else {
        if (params.fetchStatus != null && r.status !== Number(params.fetchStatus)) {
          failures.push(`assert --fetch ${params.fetch}: expected status ${params.fetchStatus}, got ${r.status}`);
        }
        if (params.jsonpath) {
          let value;
          try { value = simpleJsonPath(data, params.jsonpath); }
          catch (e) { failures.push(`assert --fetch jsonpath ${params.jsonpath}: ${e.message}`); }
          if (params.equals !== undefined) {
            const want = params.equals;
            const eq = Array.isArray(value)
              ? JSON.stringify(value) === JSON.stringify(want)
              : value == want; // intentional loose equal for "5" == 5
            if (!eq) failures.push(`assert --fetch jsonpath ${params.jsonpath}: expected ${JSON.stringify(want)}, got ${JSON.stringify(value)?.slice(0, 200)}`);
          }
          if (params.contains !== undefined) {
            const want = params.contains;
            const has = Array.isArray(value)
              ? value.some(v => v == want || (typeof v === 'string' && v.includes(String(want))))
              : (typeof value === 'string' ? value.includes(String(want)) : false);
            if (!has) failures.push(`assert --fetch jsonpath ${params.jsonpath}: expected to contain ${JSON.stringify(want)}, got ${JSON.stringify(value)?.slice(0, 200)}`);
          }
          if (params.notContains !== undefined) {
            const dont = params.notContains;
            const has = Array.isArray(value)
              ? value.some(v => v == dont || (typeof v === 'string' && v.includes(String(dont))))
              : (typeof value === 'string' ? value.includes(String(dont)) : false);
            if (has) failures.push(`assert --fetch jsonpath ${params.jsonpath}: expected NOT to contain ${JSON.stringify(dont)}, got ${JSON.stringify(value)?.slice(0, 200)}`);
          }
        }
      }
    }

    return failures.length ? { pass: false, failures } : { pass: true };
  },

  perf: async ({ metric }) => {
    if (metric === 'timing') {
      const nav = performance.getEntriesByType('navigation')[0];
      if (!nav) return { error: 'No navigation timing available' };
      const fcp = performance.getEntriesByName('first-contentful-paint')[0];
      return { dns: Math.round(nav.domainLookupEnd - nav.domainLookupStart), tcp: Math.round(nav.connectEnd - nav.connectStart), ttfb: Math.round(nav.responseStart - nav.requestStart), domReady: Math.round(nav.domContentLoadedEventEnd - nav.startTime), load: Math.round(nav.loadEventEnd - nav.startTime), fcp: fcp ? Math.round(fcp.startTime) : null };
    }
    if (metric === 'memory') {
      const mem = performance.memory;
      return mem ? { jsHeapUsed: mem.usedJSHeapSize, jsHeapTotal: mem.totalJSHeapSize, jsHeapLimit: mem.jsHeapSizeLimit, domNodes: document.querySelectorAll('*').length } : { error: 'performance.memory not available' };
    }
    if (metric === 'resources') {
      const entries = performance.getEntriesByType('resource');
      const grouped = {};
      for (const e of entries) { const t = e.initiatorType || 'other'; if (!grouped[t]) grouped[t] = { count: 0, totalSize: 0, totalDuration: 0 }; grouped[t].count++; grouped[t].totalSize += e.transferSize || 0; grouped[t].totalDuration += e.duration || 0; }
      return grouped;
    }
    return { error: `Unknown metric: ${metric}` };
  },

  // ──────────────────────────────────────────────────────────────────────
  // F1.6 — fetch shortcut: GET/POST/… using the page's auth session.
  // Returns parsed JSON when Content-Type matches, otherwise text.
  // Optional --json '<path>' extracts a value via a tiny JSONPath subset:
  //   $              whole document
  //   $.key          object property
  //   $.a.b          chained property
  //   $[N]           array index
  //   $.a[0].b       mixed
  //   $[*].key       map over array → array of values
  // No filters / wildcards beyond the above.
  // ──────────────────────────────────────────────────────────────────────
  fetch: async ({ url, method = 'GET', body = null, headers = null, json = null }) => {
    if (!url) throw new Error('fetch requires --url (or positional URL)');
    const init = { method, credentials: 'same-origin' };
    init.headers = { 'Accept': 'application/json, text/plain, */*' };
    if (headers && typeof headers === 'object') Object.assign(init.headers, headers);
    if (body != null) {
      if (typeof body === 'string') {
        init.body = body;
        if (!('Content-Type' in init.headers)) init.headers['Content-Type'] = 'application/json';
      } else {
        init.body = JSON.stringify(body);
        init.headers['Content-Type'] = 'application/json';
      }
    }
    const r = await fetch(url, init);
    const ct = r.headers.get('content-type') || '';
    let data;
    if (ct.includes('json')) {
      try { data = await r.json(); }
      catch { data = await r.text(); }
    } else {
      data = await r.text();
    }
    const result = { status: r.status, ok: r.ok, contentType: ct };
    if (json) {
      result.jsonpath = json;
      result.value = simpleJsonPath(data, json);
    } else {
      result.data = data;
    }
    return result;
  },

  // ──────────────────────────────────────────────────────────────────────
  // F2.6 — submit: form.requestSubmit() works on React-controlled forms
  // where dispatching a synthetic Enter key event is ignored.
  // ──────────────────────────────────────────────────────────────────────
  submit: async ({ formSelector } = {}) => {
    let form;
    if (formSelector) {
      form = document.querySelector(formSelector);
      if (!form) throw new Error(`No element matching form selector "${formSelector}"`);
      if (form.tagName !== 'FORM') {
        // allow passing a selector to a child — climb to nearest form ancestor.
        form = form.closest('form');
        if (!form) throw new Error(`Element "${formSelector}" is not a <form> and has no <form> ancestor`);
      }
    } else {
      const active = document.activeElement;
      form = active && active.closest ? active.closest('form') : null;
      if (!form) throw new Error('submit: no --form-selector given and document.activeElement is not inside a <form>');
    }
    if (typeof form.requestSubmit === 'function') form.requestSubmit();
    else form.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
    return { submitted: form.getAttribute('id') || form.getAttribute('name') || form.tagName, action: form.action || null };
  },

  // ──────────────────────────────────────────────────────────────────────
  // F1.8 — deep health: probes the page itself. The cheap (non-blocking)
  // server-side health lives in src/lib/httpApi.ts and never round-trips
  // here. Use this only with --deep.
  // ──────────────────────────────────────────────────────────────────────
  health_deep: async () => ({
    extension: 'alive',
    page: {
      ts: Date.now(),
      readyState: document.readyState,
      url: window.location.href,
      title: document.title,
      pendingMicrotasks: 0, // best-effort; not directly observable
      snapshotEpoch,
    },
  }),

  // ──────────────────────────────────────────────────────────────────────
  // F3.1 — reset: atomic test-isolation helper.
  //   --cookies   expire every cookie visible to JS for the current host
  //   --storage   clear localStorage + sessionStorage
  //   --cache     drop everything in the Cache Storage API
  //   --reload    reload the page after clearing (force-bypass cache)
  // Returns which steps actually ran (so AI can confirm).
  // ──────────────────────────────────────────────────────────────────────
  reset: async ({ cookies, storage, cache, reload } = {}) => {
    const cleared = [];
    const errors = [];
    if (cookies) {
      try {
        const host = location.hostname;
        const parents = [host];
        // Also try the eTLD+1 parent (e.g. "sub.example.com" → ".example.com")
        const parts = host.split('.');
        if (parts.length > 2) parents.push('.' + parts.slice(-2).join('.'));
        for (const c of document.cookie.split(';')) {
          const eq = c.indexOf('=');
          const name = (eq > -1 ? c.slice(0, eq) : c).trim();
          if (!name) continue;
          const dead = 'expires=Thu, 01 Jan 1970 00:00:00 GMT';
          document.cookie = `${name}=; ${dead}; path=/`;
          for (const d of parents) {
            document.cookie = `${name}=; ${dead}; path=/; domain=${d}`;
          }
        }
        cleared.push('cookies');
      } catch (e) { errors.push(`cookies: ${e.message}`); }
    }
    if (storage) {
      try { localStorage.clear(); sessionStorage.clear(); cleared.push('storage'); }
      catch (e) { errors.push(`storage: ${e.message}`); }
    }
    if (cache) {
      try {
        if (typeof caches !== 'undefined' && caches.keys) {
          const keys = await caches.keys();
          await Promise.all(keys.map(k => caches.delete(k)));
          cleared.push(`cache (${keys.length} stores)`);
        } else {
          errors.push('cache: Cache Storage API unavailable');
        }
      } catch (e) { errors.push(`cache: ${e.message}`); }
    }
    if (reload) {
      // Defer the reload so the result can ship back before navigation tears
      // down the iframe runtime.
      setTimeout(() => location.reload(), 50);
      cleared.push('reload (scheduled)');
    }
    if (!cleared.length && !errors.length) {
      throw new Error('reset requires at least one of: --cookies, --storage, --cache, --reload');
    }
    return errors.length ? { cleared, errors } : { cleared };
  },

  // ──────────────────────────────────────────────────────────────────────
  // F3.2 — status: one-stop "where am I" summary for AI orientation.
  //   url, title, readyState, last console error, last failed request, top
  //   visible actions. Keep it cheap; this is what AI runs after a long gap.
  // ──────────────────────────────────────────────────────────────────────
  status: async () => {
    const now = Date.now();
    const lastErr = consoleBuffer.filter(m => m.level === 'error').slice(-1)[0] || null;
    const lastFailed = networkBuffer.filter(r => typeof r.status === 'number' && r.status >= 400).slice(-1)[0] || null;
    const buttons = Array.from(document.querySelectorAll('button, [role="button"], a[role="button"], input[type="submit"]'))
      .filter(b => isVisible(b))
      .slice(0, 8);
    const topActions = buttons.map(b => {
      const t = (b.textContent || '').trim().replace(/\s+/g, ' ');
      const aria = b.getAttribute('aria-label');
      const label = aria || (t.length > 32 ? t.slice(0, 29) + '...' : t);
      return label;
    }).filter(Boolean);
    return {
      url: location.href,
      title: document.title,
      readyState: document.readyState,
      lastConsoleError: lastErr ? {
        text: (lastErr.text || '').slice(0, 200),
        ageSec: Math.round((now - lastErr.timestamp) / 1000),
      } : null,
      lastFailedRequest: lastFailed ? {
        method: lastFailed.method,
        url: lastFailed.url,
        status: lastFailed.status,
        ageSec: Math.round((now - (lastFailed.startTime || now)) / 1000),
      } : null,
      topActions,
    };
  },

  // ──────────────────────────────────────────────────────────────────────
  // F3.4 — set: unified writer for cookie / localStorage / sessionStorage.
  // (Cookies are JS-visible only; HttpOnly cannot be set from page context.)
  //   --type cookie         + --name --value [--domain --path --secure
  //                           --samesite --expires]
  //   --type local-storage  + --name --value
  //   --type session-storage + --name --value
  // ──────────────────────────────────────────────────────────────────────
  set: async ({ type, name, value, domain, path, secure, sameSite, expires } = {}) => {
    if (!type) throw new Error('set requires --type (one of: cookie, local-storage, session-storage)');
    if (!name) throw new Error('set requires --name');
    if (value === undefined) throw new Error('set requires --value');
    const v = typeof value === 'string' ? value : JSON.stringify(value);
    if (type === 'cookie') {
      let str = `${name}=${encodeURIComponent(v)}`;
      str += `; path=${path || '/'}`;
      if (domain) str += `; domain=${domain}`;
      if (secure) str += `; secure`;
      if (sameSite) str += `; samesite=${sameSite}`;
      if (expires) str += `; expires=${expires}`;
      document.cookie = str;
      // Verify (cookies set against a different domain are silently dropped)
      const verify = document.cookie.split(';').some(c => c.trim().startsWith(`${name}=`));
      return { set: 'cookie', name, verified: verify };
    }
    if (type === 'local-storage') { localStorage.setItem(name, v); return { set: 'local-storage', name, length: v.length }; }
    if (type === 'session-storage') { sessionStorage.setItem(name, v); return { set: 'session-storage', name, length: v.length }; }
    throw new Error(`set --type must be one of: cookie, local-storage, session-storage (got "${type}")`);
  },

  // Internal — used by CLI-side post-verify (F1.7). Cheap state probe.
  probe_state: async () => {
    // domHash: cheap-ish CRC of the visible body innerHTML length + a small sample
    const html = document.body ? document.body.innerHTML : '';
    const sample = html.length > 4000
      ? html.slice(0, 1000) + html.slice(html.length / 2, html.length / 2 + 1000) + html.slice(-1000)
      : html;
    let hash = 0;
    for (let i = 0; i < sample.length; i++) hash = ((hash << 5) - hash + sample.charCodeAt(i)) | 0;
    return {
      url: window.location.href,
      domLen: html.length,
      domHash: hash,
      lastNetworkId: networkBuffer.length ? networkBuffer[networkBuffer.length - 1].id : 0,
      ts: Date.now(),
    };
  },
};

// ──────────────────────────────────────────────────────────────────────
// Simple JSONPath extractor — supports only: $, .key, [N], [*]
// ──────────────────────────────────────────────────────────────────────
function simpleJsonPath(data, path) {
  if (typeof path !== 'string' || !path.startsWith('$')) {
    throw new Error(`Invalid jsonpath "${path}" — must start with $`);
  }
  let rest = path.slice(1);
  let current = [data];
  while (rest.length) {
    if (rest.startsWith('.')) {
      const m = rest.match(/^\.([A-Za-z_$][\w$]*)/);
      if (!m) throw new Error(`Invalid jsonpath segment near "${rest}"`);
      const key = m[1];
      current = current.flatMap(v => (v != null && typeof v === 'object' && key in v) ? [v[key]] : []);
      rest = rest.slice(m[0].length);
    } else if (rest.startsWith('[')) {
      const m = rest.match(/^\[(\*|\d+)\]/);
      if (!m) throw new Error(`Invalid jsonpath bracket near "${rest}"`);
      if (m[1] === '*') {
        current = current.flatMap(v => Array.isArray(v) ? v : (v != null && typeof v === 'object' ? Object.values(v) : []));
      } else {
        const idx = Number(m[1]);
        current = current.flatMap(v => Array.isArray(v) && idx < v.length ? [v[idx]] : []);
      }
      rest = rest.slice(m[0].length);
    } else {
      throw new Error(`Invalid jsonpath suffix "${rest}"`);
    }
  }
  // If the path involved no wildcard, return scalar; otherwise array.
  if (path.includes('[*]')) return current;
  return current.length ? current[0] : undefined;
}

// ============================================================================
// Entry point (called by the service worker via chrome.scripting)
// ============================================================================

async function run(action, params) {
  params = params || {};
  if (Object.prototype.hasOwnProperty.call(params, '__capture')) {
    const capture = params.__capture;
    delete params.__capture;
    if (capture) {
      captureSource = 'external';
      replaceArray(consoleBuffer, capture.console);
      replaceArray(networkBuffer, capture.network);
    } else {
      captureSource = 'none';
      consoleBuffer.length = 0;
      networkBuffer.length = 0;
    }
  } else {
    captureSource = 'hook';
    refreshBuffers();
  }

  const handler = handlers[action];
  if (!handler) {
    // Filter internal-use actions from "Did you mean" suggestions.
    const INTERNAL_ACTIONS = new Set(['probe_state']);
    const known = Object.keys(handlers).filter(k => !k.startsWith('_') && !INTERNAL_ACTIONS.has(k));
    const suggestions = fuzzyTopK(action, known, 3);
    const hint = suggestions.length ? `\n  Did you mean: ${suggestions.join(', ')}?` : '';
    throw new Error(`Unknown action "${action}".${hint}\n  Run: cockpit browser --help-all`);
  }
  if (captureSource === 'none' && (
    (action === 'assert' && (params.consoleNoErrors || params.network)) ||
    (action === 'wait' && params.networkIdle)
  )) {
    requireCapture(`${action} ${params.network ? '--network' : params.networkIdle ? '--network-idle' : '--console-no-errors'}`);
  }
  return handler(params);
}

// Fuzzy ranking — surfaces "evluate" → "evaluate" while filtering unrelated
// candidates. Uses character-bag overlap ratio (multiset intersection /
// max length); substring matches get a bonus. Threshold 0.6.
function fuzzyTopK(input, candidates, k) {
  if (!input) return [];
  const inputLow = input.toLowerCase();
  const bag = bagCounts(inputLow);
  const scored = candidates.map(c => {
    const cl = c.toLowerCase();
    const cBag = bagCounts(cl);
    let inter = 0;
    for (const [ch, n] of bag) inter += Math.min(n, cBag.get(ch) || 0);
    const ratio = inter / Math.max(inputLow.length, cl.length);
    const startsWith = cl.startsWith(inputLow) ? 0.5 : 0;
    const contains = cl.includes(inputLow) ? 0.3 : 0;
    return { c, score: ratio + startsWith + contains };
  });
  scored.sort((a, b) => b.score - a.score);
  return scored.slice(0, k).filter(s => s.score >= 0.6).map(s => s.c);
}

function bagCounts(s) {
  const m = new Map();
  for (const ch of s) m.set(ch, (m.get(ch) || 0) + 1);
  return m;
}

globalThis.__cockpitCore = { run, version: 2 };
})();
