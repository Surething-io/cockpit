/**
 * Cockpit Browser Automation Layer (ES Module)
 *
 * 注入到 Cockpit iframe 中，接收来自 BrowserBubble 的自动化命令，
 * 构建 a11y tree、执行 DOM 操作、返回结果。
 *
 * 通过 content.js 的 activateCockpitBridge() 动态 import()。
 * 运行在 content script isolated world 中（保留 chrome.runtime 访问权）。
 */

let _realParent = null;
let _chrome = null;

const LOG_PREFIX = '[Cockpit Automation]';

// ============================================================================
// Ref 系统：为 a11y tree 中的元素分配稳定的 ref ID
// ============================================================================

let refCounter = 0;
const refToElement = new Map();
const elementToRef = new WeakMap();

function clearRefs() {
  refCounter = 0;
  refToElement.clear();
}

function assignRef(el) {
  const existing = elementToRef.get(el);
  if (existing) return existing;
  const ref = `e${refCounter++}`;
  refToElement.set(ref, el);
  elementToRef.set(el, ref);
  return ref;
}

function findByRef(ref) {
  const el = refToElement.get(ref);
  if (!el || !el.isConnected) {
    throw new Error(`Element ref "${ref}" not found or disconnected`);
  }
  return el;
}

// ============================================================================
// A11y Tree 构建
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

function buildA11yTree(root = document.body, maxDepth = 12) {
  clearRefs();
  const lines = [];

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
      }

      const extras = [];
      if (el.tagName.match(/^H[1-6]$/)) extras.push(`level=${el.tagName[1]}`);
      if (el instanceof HTMLInputElement) {
        if (el.type === 'checkbox' || el.type === 'radio') extras.push(el.checked ? 'checked' : 'unchecked');
        if (el.disabled) extras.push('disabled');
        if (el.value) extras.push(`value="${el.value.slice(0, 30)}"`);
      }
      if (el instanceof HTMLSelectElement && el.value) extras.push(`value="${el.value}"`);
      if (el.getAttribute('aria-expanded')) extras.push(`expanded=${el.getAttribute('aria-expanded')}`);
      if (el.getAttribute('aria-selected') === 'true') extras.push('selected');
      if (el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled')) extras.push('disabled');

      if (extras.length) line += ` [${extras.join(', ')}]`;
      line += ` [${ref}]`;
      lines.push(line);
    }

    for (const child of el.children) {
      walk(child, isContainer ? depth : depth + 1);
    }
  }

  walk(root || document.body, 0);
  return lines.join('\n');
}

// ============================================================================
// Console 拦截
// ============================================================================

const consoleBuffer = [];
const MAX_CONSOLE_BUFFER = 500;
const originalConsole = {};

function initConsoleCapture() {
  ['log', 'info', 'warn', 'error', 'debug'].forEach(level => {
    originalConsole[level] = console[level];
    console[level] = function (...args) {
      consoleBuffer.push({
        level,
        text: args.map(a => {
          try { return typeof a === 'string' ? a : JSON.stringify(a); }
          catch { return String(a); }
        }).join(' '),
        timestamp: Date.now(),
      });
      if (consoleBuffer.length > MAX_CONSOLE_BUFFER) {
        consoleBuffer.splice(0, consoleBuffer.length - MAX_CONSOLE_BUFFER);
      }
      originalConsole[level].apply(console, args);
    };
  });
}

// ============================================================================
// Network 捕获（接收 Main World 的 network-capture.js 通过 CustomEvent 发来的条目）
//
// fetch / XHR 拦截在 Main World 执行（network-capture.js），
// 本层只负责：存储 buffer、管理录制状态、处理 CLI 命令。
// ============================================================================

const networkBuffer = [];
const MAX_NETWORK_BUFFER = 500;

// 录制状态：由本层管理，通过 CustomEvent 同步给 Main World
const networkRecording = {
  active: false,
  filters: {},   // { url, method, status }
  timer: null,   // 自动过期定时器
  startedAt: 0,
};

// 清除所有 entry 的 body 数据（过期时调用）
function clearAllBodies() {
  for (const entry of networkBuffer) {
    entry.requestHeaders = null;
    entry.requestBody = null;
    entry.responseHeaders = null;
    entry.responseBody = null;
  }
}

// 同步录制状态到 Main World 的 network-capture.js
function syncRecordingToMainWorld() {
  window.dispatchEvent(new CustomEvent('cockpit:network-recording', {
    detail: { active: networkRecording.active, filters: networkRecording.filters },
  }));
}

// 监听 Main World 发来的网络条目
function initNetworkListener() {
  // 请求发起时收到占位条目（保持发起顺序）
  window.addEventListener('cockpit:network-entry', (e) => {
    networkBuffer.push(e.detail);
    if (networkBuffer.length > MAX_NETWORK_BUFFER) networkBuffer.splice(0, 1);
  });
  // 响应完成时收到更新（补全 status / duration / body 等字段）
  window.addEventListener('cockpit:network-update', (e) => {
    const update = e.detail;
    const entry = networkBuffer.find(r => r.id === update.id);
    if (entry) Object.assign(entry, update);
  });
  // 通知 Main World：Isolated World 已就绪，可以 flush 缓存的条目
  window.dispatchEvent(new CustomEvent('cockpit:network-bridge-ready'));
}

// ============================================================================
// 命令处理器
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

  snapshot: async () => buildA11yTree(document.body),

  screenshot: async () => {
    // 1) 通知父页面（项目 iframe）：切到 console view + 切到本项目 + 返回 iframe bounds
    const boundsReqId = 'ss-' + Date.now();
    const bounds = await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => reject(new Error('Timeout preparing screenshot')), 5000);
      const handler = (event) => {
        if (event.data?.type === 'cockpit:screenshot-bounds' && event.data.reqId === boundsReqId) {
          window.removeEventListener('message', handler);
          clearTimeout(timeout);
          resolve(event.data.bounds);
        }
      };
      window.addEventListener('message', handler);
      _realParent.postMessage({ type: 'cockpit:prepare-screenshot', reqId: boundsReqId }, '*');
    });

    // 2) captureVisibleTab 截取整个浏览器标签页
    const dataUrl = await new Promise((resolve, reject) => {
      _chrome.runtime.sendMessage({ type: 'cockpit:capture-tab' }, (response) => {
        if (_chrome.runtime.lastError) { reject(new Error(_chrome.runtime.lastError.message)); return; }
        if (response?.ok) resolve(response.dataUrl);
        else reject(new Error(response?.error || 'Screenshot failed'));
      });
    });

    // 3) 裁切到 iframe 区域
    const img = new Image();
    await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = dataUrl; });
    const cropCanvas = document.createElement('canvas');
    cropCanvas.width = bounds.width;
    cropCanvas.height = bounds.height;
    const cropCtx = cropCanvas.getContext('2d');
    cropCtx.drawImage(img, bounds.x, bounds.y, bounds.width, bounds.height, 0, 0, bounds.width, bounds.height);
    const result = cropCanvas.toDataURL('image/png');

    // 4) 通知父页面截图完成，恢复界面
    _realParent.postMessage({ type: 'cockpit:screenshot-done' }, '*');

    return { image: result, format: 'png' };
  },

  click: async ({ ref }) => {
    const el = findByRef(ref);
    el.scrollIntoView({ block: 'nearest' });
    el.click();
    return { clicked: ref };
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

  fill: async ({ ref, value }) => {
    const el = findByRef(ref);
    el.focus();
    if (el.tagName === 'SELECT') {
      el.value = value;
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return { filled: ref, value };
    }
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')?.set
      || Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value')?.set;
    if (setter) setter.call(el, value);
    else el.value = value;
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { filled: ref, value };
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

  wait: async ({ text, ref: waitRef, url: waitUrl, time, timeout = 10000 }) => {
    const start = Date.now();
    const poll = (check) => new Promise((resolve, reject) => {
      const interval = setInterval(() => {
        if (check()) { clearInterval(interval); resolve(true); return; }
        if (Date.now() - start > timeout) { clearInterval(interval); reject(new Error(`Wait timeout after ${timeout}ms`)); }
      }, 100);
    });

    if (time) { await new Promise(r => setTimeout(r, time)); return { waited: `${time}ms` }; }
    if (text) { await poll(() => document.body.textContent.includes(text)); return { waited: `text "${text}"` }; }
    if (waitRef) { await poll(() => refToElement.has(waitRef) && refToElement.get(waitRef).isConnected); return { waited: `ref ${waitRef}` }; }
    if (waitUrl) {
      const pat = waitUrl.includes('*') ? new RegExp('^' + waitUrl.replace(/\*/g, '.*') + '$') : null;
      await poll(() => pat ? pat.test(location.href) : location.href.includes(waitUrl));
      return { waited: `url "${waitUrl}"` };
    }
    throw new Error('wait requires one of: text, ref, url, time');
  },

  evaluate: async ({ js, allFrames }) => {
    // 通过 background.js 的 chrome.scripting.executeScript 在 main world 执行
    // 不受页面 CSP 限制，可访问页面 JS 变量（React state 等）
    // allFrames: true → 在所有 frame 中执行（解决跨域 iframe 访问问题）
    return new Promise((resolve) => {
      _chrome.runtime.sendMessage({ type: 'cockpit:evaluate', js, allFrames: !!allFrames }, (response) => {
        if (_chrome.runtime.lastError) {
          resolve({ error: _chrome.runtime.lastError.message });
          return;
        }
        if (response?.ok) resolve(response.data);
        else resolve({ error: response?.error || 'Evaluation failed' });
      });
    });
  },

  console: async ({ level, clear: doClear }) => {
    if (doClear) { consoleBuffer.length = 0; return { cleared: true }; }
    return level ? consoleBuffer.filter(m => m.level === level) : [...consoleBuffer];
  },

  network: async ({ status, method: fm, type: ft, clear: doClear }) => {
    if (doClear) { networkBuffer.length = 0; return { cleared: true }; }
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

  // 录制控制：start 开始捕获 body，stop 停止，status 查看状态
  network_record: async ({ action = 'status', url, method, status, ttl = 600 }) => {
    if (action === 'start') {
      // 清除旧的过期定时器
      if (networkRecording.timer) clearTimeout(networkRecording.timer);
      networkRecording.active = true;
      networkRecording.filters = {};
      if (url) networkRecording.filters.url = url;
      if (method) networkRecording.filters.method = method;
      if (status) networkRecording.filters.status = status;
      networkRecording.startedAt = Date.now();
      syncRecordingToMainWorld();
      // ttl 秒后自动过期（默认 10 分钟）
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
      // 停止后不立即清 body，允许查询已录制的数据
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
    if (params.visible !== undefined) {
      const el = findByRef(params.ref);
      const vis = isVisible(el);
      if (params.visible && !vis) failures.push(`Element ${params.ref} is not visible`);
      if (!params.visible && vis) failures.push(`Element ${params.ref} is visible`);
    }
    if (params.text !== undefined) {
      const el = findByRef(params.ref);
      const actual = el.textContent?.trim() || '';
      if (!actual.includes(params.text)) failures.push(`Expected text "${params.text}", got "${actual.slice(0, 100)}"`);
    }
    if (params.checked !== undefined) { const el = findByRef(params.ref); if (el.checked !== params.checked) failures.push(`Expected checked=${params.checked}, got ${el.checked}`); }
    if (params.disabled !== undefined) { const el = findByRef(params.ref); const d = el.disabled || el.getAttribute('aria-disabled') === 'true'; if (d !== params.disabled) failures.push(`Expected disabled=${params.disabled}, got ${d}`); }
    if (params.url) { const pat = params.url.includes('*') ? new RegExp('^' + params.url.replace(/\*/g, '.*') + '$') : null; const m = pat ? pat.test(location.href) : location.href.includes(params.url); if (!m) failures.push(`URL "${location.href}" does not match "${params.url}"`); }
    if (params.title) { if (!document.title.includes(params.title)) failures.push(`Title "${document.title}" does not match "${params.title}"`); }
    if (params.consoleNoErrors) { const errs = consoleBuffer.filter(m => m.level === 'error'); if (errs.length) failures.push(`Found ${errs.length} console errors: ${errs.map(e => e.text).join('; ').slice(0, 200)}`); }
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
};

// ============================================================================
// 命令分发
// ============================================================================

function handleCommand(event) {
  if (!event.data || event.data.type !== 'cockpit:cmd') return;
  if (event.source !== _realParent) return;

  const { reqId, action, params = {} } = event.data;
  const handler = handlers[action];

  if (!handler) {
    _realParent.postMessage({ type: 'cockpit:cmd-result', reqId, ok: false, error: `Unknown action: ${action}` }, '*');
    return;
  }

  handler(params)
    .then(data => _realParent.postMessage({ type: 'cockpit:cmd-result', reqId, ok: true, data }, '*'))
    .catch(err => _realParent.postMessage({ type: 'cockpit:cmd-result', reqId, ok: false, error: err.message || String(err) }, '*'));
}

// ============================================================================
// 导出初始化函数
// ============================================================================

export function initAutomation(realParent, chromeApi) {
  _realParent = realParent;
  _chrome = chromeApi;

  window.addEventListener('message', handleCommand);
  initConsoleCapture();
  initNetworkListener();

  console.log(LOG_PREFIX, 'Automation layer activated');
}
