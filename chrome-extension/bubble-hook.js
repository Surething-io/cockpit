/**
 * OpenCockpit Bridge — bubble hook (MAIN world, document_start, all frames).
 *
 * Declared for every page, but inert everywhere except a Cockpit browser
 * bubble. A frame counts as a bubble only when ALL hold:
 *   1. its browsing-context name is `cockpit-bubble-<id>` (BrowserBubble sets
 *      the iframe `name` attribute),
 *   2. its immediate parent is a loopback http origin, read from
 *      `location.ancestorOrigins`, which the framed page cannot forge, and
 *   3. it is the parent's own origin — bubbles only show Cockpit-served
 *      content; a site framed by some other local page never qualifies.
 *
 * What it does inside a bubble (and nothing else):
 *   - records console output and fetch/XHR traffic into a bounded buffer that
 *     the extension's isolated-world automation core pulls on demand;
 *   - reports URL changes and new-tab requests to the parent bubble UI.
 *
 * It holds no command channel. Commands reach the page only through the
 * extension service worker (chrome.scripting / chrome.debugger), which takes
 * them from the native messaging host — never from the page or its parent.
 *
 * Cross-world payloads are JSON strings: CustomEvent.detail objects do not
 * reliably survive the MAIN ↔ ISOLATED boundary, strings always do.
 */
(function () {
  'use strict';

  if (window === window.top) return;
  if (typeof window.name !== 'string' || !window.name.startsWith('cockpit-bubble-')) return;
  var ancestors = location.ancestorOrigins;
  if (!ancestors || !ancestors.length) return;
  var parentOrigin = ancestors[0];
  if (!/^http:\/\/(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(parentOrigin)) return;
  // Bubbles only show Cockpit-served content (local HTML apps, file previews);
  // web pages open as Chrome tabs. So the bubble must be the parent's own origin.
  if (location.origin !== parentOrigin) return;
  if (window.__cockpitBubbleHook) return;
  window.__cockpitBubbleHook = true;

  var MAX_CONSOLE = 500;
  var MAX_NETWORK = 500;
  var MAX_BODY_SIZE = 128 * 1024;

  var consoleBuffer = [];
  var networkBuffer = [];
  var networkById = new Map();
  var networkReqId = 0;
  var recording = { active: false, filters: {} };

  // ── Parent notifications (URL sync, new tabs) ────────────────────────

  var realParent = window.parent;
  function notifyParent(type, data) {
    try {
      var msg = Object.assign({ type: 'cockpit:' + type }, data);
      realParent.postMessage(msg, parentOrigin);
    } catch (e) { /* parent gone */ }
  }

  // ── Console capture ──────────────────────────────────────────────────

  function stringify(a) {
    if (typeof a === 'string') return a;
    if (a instanceof Error) return a.stack || (a.name + ': ' + a.message);
    try { return JSON.stringify(a); } catch (e) { return String(a); }
  }

  function pushConsole(level, text) {
    consoleBuffer.push({ level: level, text: text, timestamp: Date.now() });
    if (consoleBuffer.length > MAX_CONSOLE) consoleBuffer.splice(0, consoleBuffer.length - MAX_CONSOLE);
  }

  var LEVELS = ['log', 'info', 'warn', 'error', 'debug'];
  function record(level, args) {
    try {
      var parts = [];
      for (var i = 0; i < args.length; i++) parts.push(stringify(args[i]));
      pushConsole(level, parts.join(' '));
    } catch (e) { /* never break the page's logging */ }
  }

  // The console wrapper must belong to the PAGE, not to this extension script:
  // Chrome files any console.error whose calling frame is extension code under
  // the extension's own "Errors" list, so a page's errors would show up as
  // OpenCockpit Bridge errors. An inline <script> is page code; it forwards
  // each call to `record` and then calls the original console itself.
  var sinkKey = '__cockpitConsoleSink_' + Math.random().toString(36).slice(2);
  window[sinkKey] = record;
  var probe = console.log;
  try {
    var el = document.createElement('script');
    el.textContent =
      '(function(sink){var c=console;' + JSON.stringify(LEVELS) + '.forEach(function(l){' +
      'var o=c[l];if(typeof o!=="function")return;' +
      'c[l]=function(){try{sink(l,arguments)}catch(e){}return o.apply(this,arguments)}});' +
      '})(window[' + JSON.stringify(sinkKey) + ']);';
    (document.head || document.documentElement).appendChild(el);
    el.remove();
  } catch (e) { /* fall through to the in-extension wrapper */ }
  delete window[sinkKey];
  if (console.log === probe) {
    // Inline scripts blocked (page CSP): wrap from here; errors may then be
    // attributed to the extension, but capture still works.
    LEVELS.forEach(function (level) {
      var original = console[level];
      if (typeof original !== 'function') return;
      console[level] = function () {
        record(level, arguments);
        return original.apply(this, arguments);
      };
    });
  }

  window.addEventListener('error', function (e) {
    var where = e.filename ? ' (' + e.filename + ':' + e.lineno + ')' : '';
    pushConsole('error', 'Uncaught ' + (e.error ? stringify(e.error) : e.message) + where);
  });
  window.addEventListener('unhandledrejection', function (e) {
    pushConsole('error', 'Unhandled rejection: ' + stringify(e.reason));
  });

  // ── Network capture ──────────────────────────────────────────────────

  function shouldCaptureBody(method, url, status) {
    if (!recording.active) return false;
    var f = recording.filters || {};
    if (f.method && String(method).toUpperCase() !== String(f.method).toUpperCase()) return false;
    if (f.url) {
      var pattern = String(f.url).replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (!new RegExp(pattern, 'i').test(url)) return false;
    }
    if (f.status && status != null) {
      var ranges = String(f.status).split(',').map(function (s) { return s.trim(); });
      var match = ranges.some(function (range) {
        if (range.endsWith('xx')) { var base = parseInt(range[0], 10) * 100; return status >= base && status < base + 100; }
        return status === parseInt(range, 10);
      });
      if (!match) return false;
    }
    return true;
  }

  function captureBody(text) {
    if (text == null) return null;
    if (text.length > MAX_BODY_SIZE) return { truncated: true, size: text.length };
    return text;
  }

  function addEntry(entry) {
    networkBuffer.push(entry);
    networkById.set(entry.id, entry);
    if (networkBuffer.length > MAX_NETWORK) {
      var dropped = networkBuffer.splice(0, networkBuffer.length - MAX_NETWORK);
      dropped.forEach(function (d) { networkById.delete(d.id); });
    }
  }

  function updateEntry(id, update) {
    var entry = networkById.get(id);
    if (entry) Object.assign(entry, update);
  }

  function isTextual(ct) {
    return ct.indexOf('json') >= 0 || ct.indexOf('text') >= 0 || ct.indexOf('xml') >= 0 ||
      ct.indexOf('html') >= 0 || ct.indexOf('javascript') >= 0;
  }

  var originalFetch = window.fetch;
  if (typeof originalFetch === 'function') {
    window.fetch = async function () {
      var args = arguments;
      var id = ++networkReqId;
      var req;
      try {
        req = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
      } catch (e) {
        return originalFetch.apply(this, args);
      }
      var wantBody = shouldCaptureBody(req.method, req.url, null);
      var reqHeaders = null;
      var reqBody = null;
      if (wantBody) {
        reqHeaders = {};
        req.headers.forEach(function (v, k) { reqHeaders[k] = v; });
        try { reqBody = captureBody(await req.clone().text()); } catch (e) { /* ignore */ }
      }
      var startTime = Date.now();
      addEntry({
        id: id, method: req.method, url: req.url, type: 'fetch',
        startTime: startTime, status: null, duration: null,
        requestHeaders: reqHeaders, requestBody: reqBody,
        responseHeaders: null, responseBody: null, responseSize: null,
        recorded: wantBody,
      });
      try {
        var res = await originalFetch.apply(this, args);
        var update = { status: res.status, duration: Date.now() - startTime };
        if (wantBody || shouldCaptureBody(req.method, req.url, res.status)) {
          update.recorded = true;
          var resHeaders = {};
          res.headers.forEach(function (v, k) { resHeaders[k] = v; });
          update.responseHeaders = resHeaders;
          if (!reqHeaders) {
            update.requestHeaders = {};
            req.headers.forEach(function (v, k) { update.requestHeaders[k] = v; });
          }
          if (isTextual(res.headers.get('content-type') || '')) {
            try {
              var text = await res.clone().text();
              update.responseSize = text.length;
              update.responseBody = captureBody(text);
            } catch (e) { /* ignore */ }
          }
        }
        updateEntry(id, update);
        return res;
      } catch (err) {
        updateEntry(id, { status: 0, duration: Date.now() - startTime, error: err && err.message });
        throw err;
      }
    };
  }

  var XHROpen = XMLHttpRequest.prototype.open;
  var XHRSend = XMLHttpRequest.prototype.send;
  var XHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
  var xhrMeta = new WeakMap();

  XMLHttpRequest.prototype.open = function (method, url) {
    xhrMeta.set(this, { method: String(method).toUpperCase(), url: String(url), id: ++networkReqId, headers: {} });
    return XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    var meta = xhrMeta.get(this);
    if (meta) meta.headers[String(name).toLowerCase()] = value;
    return XHRSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    var meta = xhrMeta.get(this);
    if (meta) {
      var absUrl = meta.url;
      try { absUrl = new URL(meta.url, location.href).href; } catch (e) { /* keep raw */ }
      var wantBody = shouldCaptureBody(meta.method, absUrl, null);
      var startTime = Date.now();
      addEntry({
        id: meta.id, method: meta.method, url: absUrl, type: 'xhr',
        startTime: startTime, status: null, duration: null,
        requestHeaders: wantBody ? meta.headers : null,
        requestBody: wantBody && typeof body === 'string' ? captureBody(body) : null,
        responseHeaders: null, responseBody: null, responseSize: null,
        recorded: wantBody,
      });
      this.addEventListener('loadend', function () {
        var update = { status: this.status, duration: Date.now() - startTime };
        if (wantBody || shouldCaptureBody(meta.method, absUrl, this.status)) {
          update.recorded = true;
          update.requestHeaders = meta.headers;
          try {
            var headers = {};
            this.getAllResponseHeaders().trim().split(/[\r\n]+/).forEach(function (line) {
              var parts = line.split(': ');
              var k = parts.shift();
              if (k) headers[k.toLowerCase()] = parts.join(': ');
            });
            update.responseHeaders = headers;
          } catch (e) { /* ignore */ }
          try {
            if (this.responseType === '' || this.responseType === 'text') {
              var text = this.responseText;
              update.responseSize = text.length;
              update.responseBody = captureBody(text);
            }
          } catch (e) { /* ignore */ }
        }
        updateEntry(meta.id, update);
      });
    }
    return XHRSend.apply(this, arguments);
  };

  // ── Isolated-world protocol ──────────────────────────────────────────
  //   pull            → reply with `cockpit:hook-sync` (JSON snapshot), synchronously
  //   clear           → detail: "console" | "network"
  //   clear-bodies    → drop captured headers/bodies (recording expiry)
  //   recording       → detail: JSON { active, filters }

  window.addEventListener('cockpit:hook-pull', function () {
    window.dispatchEvent(new CustomEvent('cockpit:hook-sync', {
      detail: JSON.stringify({ console: consoleBuffer, network: networkBuffer }),
    }));
  });

  window.addEventListener('cockpit:hook-clear', function (e) {
    if (e.detail === 'console') consoleBuffer.length = 0;
    if (e.detail === 'network') { networkBuffer.length = 0; networkById.clear(); }
  });

  window.addEventListener('cockpit:hook-clear-bodies', function () {
    networkBuffer.forEach(function (entry) {
      entry.requestHeaders = null;
      entry.requestBody = null;
      entry.responseHeaders = null;
      entry.responseBody = null;
    });
  });

  window.addEventListener('cockpit:hook-recording', function (e) {
    try { recording = JSON.parse(e.detail); } catch (err) { /* ignore malformed */ }
  });

  // ── New tabs → new bubbles ───────────────────────────────────────────

  document.addEventListener('click', function (e) {
    var anchor = e.target;
    while (anchor && anchor.tagName !== 'A') anchor = anchor.parentElement;
    if (!anchor) return;
    var href = anchor.href;
    if (!href || href.indexOf('javascript:') === 0 || href.indexOf('#') === 0) return;
    var target = anchor.target;
    if (target === '_blank' || (target && target !== '_self' && target !== '_top' && target !== '_parent')) {
      e.preventDefault();
      e.stopPropagation();
      notifyParent('new-tab', { url: href });
    }
  }, true);

  var originalOpen = window.open;
  window.open = function (url, target, features) {
    if (url) {
      var absoluteUrl = url;
      try { absoluteUrl = new URL(url, location.href).href; } catch (e) { /* keep raw */ }
      notifyParent('new-tab', { url: absoluteUrl });
      return null;
    }
    return originalOpen.call(this, url, target, features);
  };

  // ── URL sync ─────────────────────────────────────────────────────────

  var lastUrl = location.href;
  function checkUrlChange() {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      notifyParent('navigate', { url: lastUrl });
    }
  }
  var originalPushState = history.pushState;
  var originalReplaceState = history.replaceState;
  history.pushState = function () { var r = originalPushState.apply(this, arguments); checkUrlChange(); return r; };
  history.replaceState = function () { var r = originalReplaceState.apply(this, arguments); checkUrlChange(); return r; };
  window.addEventListener('popstate', checkUrlChange);
  window.addEventListener('hashchange', checkUrlChange);

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { notifyParent('loaded', { url: location.href }); });
  } else {
    notifyParent('loaded', { url: location.href });
  }
})();
