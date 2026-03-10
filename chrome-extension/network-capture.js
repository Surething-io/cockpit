/**
 * Network Capture - Main World 网络拦截
 *
 * 注入到 iframe 的 main world（和 disguise.js 同方式），
 * 拦截真实的 fetch / XMLHttpRequest，通过 CustomEvent 把
 * 捕获的请求条目发送回 Isolated World 的 automation.js。
 *
 * 通信协议：
 *   Main → Isolated:  cockpit:network-entry   { ...entry }       请求发起时立即发送（占位）
 *   Main → Isolated:  cockpit:network-update  { id, status, ... } 响应完成时发送（补全字段）
 *   Isolated → Main:  cockpit:network-recording { active, filters }
 *   Isolated → Main:  cockpit:network-bridge-ready  (触发 buffer flush)
 */
(function () {
  'use strict';

  let networkReqId = 0;
  const MAX_BODY_SIZE = 128 * 1024;

  // 录制状态（由 Isolated World 的 automation.js 同步过来）
  let recording = { active: false, filters: {} };

  // Bridge 就绪前缓存条目，防止 automation.js 还没 import 完时丢条目
  let entryBuffer = [];
  let bridgeReady = false;

  // ── 事件监听 ────────────────────────────────────────────

  window.addEventListener('cockpit:network-recording', function (e) {
    recording = e.detail;
  });

  window.addEventListener('cockpit:network-bridge-ready', function () {
    bridgeReady = true;
    if (entryBuffer.length) {
      entryBuffer.forEach(emitEntry);
      entryBuffer = [];
    }
  });

  // ── 工具函数 ────────────────────────────────────────────

  function shouldCaptureBody(method, url, status) {
    if (!recording.active) return false;
    var f = recording.filters;
    if (f.method && method.toUpperCase() !== f.method.toUpperCase()) return false;
    if (f.url) {
      var pattern = f.url.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*');
      if (!new RegExp(pattern, 'i').test(url)) return false;
    }
    if (f.status && status != null) {
      var ranges = f.status.split(',').map(function (s) { return s.trim(); });
      var match = ranges.some(function (range) {
        if (range.endsWith('xx')) { var base = parseInt(range[0]) * 100; return status >= base && status < base + 100; }
        return status === parseInt(range);
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

  function emitEntry(entry) {
    if (!bridgeReady) { entryBuffer.push(entry); return; }
    window.dispatchEvent(new CustomEvent('cockpit:network-entry', { detail: entry }));
  }

  function emitUpdate(update) {
    window.dispatchEvent(new CustomEvent('cockpit:network-update', { detail: update }));
  }

  // ── Fetch 拦截 ──────────────────────────────────────────

  var originalFetch = window.fetch;
  window.fetch = async function () {
    var args = arguments;
    var id = ++networkReqId;
    var req = args[0] instanceof Request ? args[0] : new Request(args[0], args[1]);
    var wantBody = shouldCaptureBody(req.method, req.url, null);

    var reqHeaders = null;
    var reqBody = null;
    if (wantBody) {
      reqHeaders = {};
      req.headers.forEach(function (v, k) { reqHeaders[k] = v; });
      try { reqBody = captureBody(await req.clone().text()); } catch (e) { /* ignore */ }
    }

    var entry = {
      id: id, method: req.method, url: req.url, type: 'fetch',
      startTime: Date.now(), status: null, duration: null,
      requestHeaders: reqHeaders, requestBody: reqBody,
      responseHeaders: null, responseBody: null, responseSize: null,
      recorded: wantBody,
    };
    // 立即 emit 占位条目，保持请求发起顺序
    emitEntry(entry);

    try {
      var res = await originalFetch.apply(this, args);
      var update = { id: id, status: res.status, duration: Date.now() - entry.startTime };
      var capture = wantBody || shouldCaptureBody(req.method, req.url, res.status);
      if (capture) {
        update.recorded = true;
        var resHeaders = {};
        res.headers.forEach(function (v, k) { resHeaders[k] = v; });
        update.responseHeaders = resHeaders;
        if (!reqHeaders) {
          update.requestHeaders = {};
          req.headers.forEach(function (v, k) { update.requestHeaders[k] = v; });
        }
        var ct = res.headers.get('content-type') || '';
        if (ct.includes('json') || ct.includes('text') || ct.includes('xml') || ct.includes('html') || ct.includes('javascript')) {
          try {
            var text = await res.clone().text();
            update.responseSize = text.length;
            update.responseBody = captureBody(text);
          } catch (e) { /* ignore */ }
        }
      }
      emitUpdate(update);
      return res;
    } catch (err) {
      emitUpdate({ id: id, status: 0, duration: Date.now() - entry.startTime, error: err.message });
      throw err;
    }
  };

  // ── XMLHttpRequest 拦截 ─────────────────────────────────

  var XHROpen = XMLHttpRequest.prototype.open;
  var XHRSend = XMLHttpRequest.prototype.send;
  var XHRSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._cockpit = { method: method, url: String(url), id: ++networkReqId };
    return XHROpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.setRequestHeader = function (name, value) {
    if (this._cockpit) {
      if (!this._cockpit.requestHeaders) this._cockpit.requestHeaders = {};
      this._cockpit.requestHeaders[name.toLowerCase()] = value;
    }
    return XHRSetRequestHeader.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function (body) {
    if (this._cockpit) {
      var wantBody = shouldCaptureBody(this._cockpit.method, this._cockpit.url, null);
      var entryId = this._cockpit.id;
      var entry = {
        id: entryId, method: this._cockpit.method,
        url: this._cockpit.url, type: 'xhr',
        startTime: Date.now(), status: null, duration: null,
        requestHeaders: wantBody ? (this._cockpit.requestHeaders || null) : null,
        requestBody: wantBody && typeof body === 'string' ? captureBody(body) : null,
        responseHeaders: null, responseBody: null, responseSize: null,
        recorded: wantBody,
      };
      // 立即 emit 占位条目，保持请求发起顺序
      emitEntry(entry);
      var entryMethod = entry.method;
      var entryUrl = entry.url;
      var entryStartTime = entry.startTime;
      this.addEventListener('loadend', function () {
        var update = { id: entryId, status: this.status, duration: Date.now() - entryStartTime };
        var capture = wantBody || shouldCaptureBody(entryMethod, entryUrl, this.status);
        if (capture) {
          update.recorded = true;
          try {
            var raw = this.getAllResponseHeaders();
            var headers = {};
            raw.trim().split(/[\r\n]+/).forEach(function (line) {
              var parts = line.split(': ');
              var k = parts.shift();
              if (k) headers[k.toLowerCase()] = parts.join(': ');
            });
            update.responseHeaders = headers;
          } catch (e) { /* ignore */ }
          try {
            var text = this.responseText;
            update.responseSize = text.length;
            update.responseBody = captureBody(text);
          } catch (e) { /* ignore */ }
        }
        emitUpdate(update);
      });
    }
    return XHRSend.apply(this, arguments);
  };
})();
