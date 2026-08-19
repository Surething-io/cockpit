/**
 * htmlBashSdk — the `window.cockpit` bash SDK injected into previewed HTML.
 *
 * Two injection sites share this single source of truth:
 *   - HtmlAppFrame (client, srcDoc iframe): explorer file preview + chat preview.
 *     A srcDoc document's URL is `about:srcdoc` (no origin), so the host MUST
 *     bake an absolute `wsUrl`.
 *   - /apps/local (server, real-URL iframe): the console browser bubble loads
 *     local HTML over `http://host/apps/local/...`. There the page has a real
 *     same-origin URL, so `wsUrl` can be left empty and the SDK derives it from
 *     `window.location` at runtime.
 *
 * SDK surface (mirrors the Bash tool the model already knows):
 *   window.cockpit.cwd : string
 *   window.cockpit.bash(command, opts?)
 *     - foreground (default): Promise<{ stdout, stderr, exitCode }>
 *     - background (opts.background: true): { kill() }, streams via callbacks
 *   opts = { background?, cwd?, onOutput?, onStderr?, onExit?, onError? }
 *
 * Theme: FOLLOWS the Cockpit host by default — the console bubble pushes a
 * THEME_CHANGE postMessage on iframe load and ThemeProvider broadcasts it on
 * toggle; outside Cockpit the meta content (auto/light/dark) decides. The
 * floating toggle flips light/dark, remembered per app across
 * reloads (key namespaced by cockpit-name / page path; localStorage is
 * shared); a stored user choice wins over the host. window.cockpit.toggleTheme()
 * too.
 *
 * Bash call log: every bash() the page issues is recorded and shown in a
 * floating panel, so the user can audit what a previewed page actually ran.
 * Unlike the theme toggle it is NOT meta-opt-in (a page would just omit the
 * tag), but its button stays hidden until the page's first bash call. In
 * memory, per page — no API, no persistence; see the block comment on it.
 *
 * Both buttons live in one draggable "dock" that snaps to the nearest of the 4
 * corners, so they can be moved off whatever the app puts under them; the
 * corner is global.
 *
 * One lazily-opened WS per iframe; concurrent commands are multiplexed by a
 * client-generated call id. The WS only opens on the first bash() call.
 */

// Vanilla ES5-ish JS, injected verbatim into the iframe. `__CWD__` / `__WS_URL__`
// are replaced with JSON-encoded literals before injection. `__WS_URL__` may be
// "" — the SDK then derives the endpoint from window.location.
const SDK_SOURCE = `
(function () {
  if (window.cockpit) return;

  // Language — parked on <html data-cockpit-lang>, NOT delivered by listener
  // alone. The host pushes cockpit:language-change once, on the iframe's load
  // event. Anything registering a listener later misses it forever, and the
  // widget bundles (/html-lib markdown / json / pdf) are lazily fetched — they
  // always register after load, so they used to fall back to navigator.language
  // and disagree with the Cockpit setting until the user toggled it. This script
  // is injected at the very start of <head>, so it is guaranteed to be listening
  // first; parking the value turns a one-shot message into order-independent
  // state any later reader can just read.
  //
  // A DEDICATED attribute, not <html lang>: pages ship their own lang="en" (the
  // built-in file-viewer does), so <html lang> cannot distinguish "the host told
  // us" from "the document's own default" — reading it would pin every reader to
  // the page's hardcoded value and silently kill the navigator fallback.
  var applyLang = function (lang) {
    if (!lang) return;
    try {
      document.documentElement.setAttribute('data-cockpit-lang', lang);
      document.documentElement.lang = lang;   // keep the document honest for a11y
    } catch (e) {}
  };
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (d && d.type === 'cockpit:language-change') applyLang(d.lang);
  });

  // Dock — the one floating container every piece of host chrome mounts into
  // (theme toggle, bash call log). Independent floating buttons do not work:
  // they all default to the same corner and cover each other, and the user then
  // has to drag each one separately off whatever the app put underneath.
  //
  // The dock is DRAGGABLE and snaps to whichever of the 4 viewport corners it
  // was released nearest to. A fixed corner is unworkable: the host picks the
  // spot, the app owns the content, and any app with its own corner affordance
  // (close button, toolbar, TOC) had it permanently covered with no escape.
  // Only the CORNER is persisted, never pixels: on resize/rotate a remembered
  // coordinate can land off-screen, while a corner is always re-derivable. It is
  // remembered GLOBALLY (not per app) — one gesture then holds for every HTML
  // app, which is the common case since apps tend to crowd the same corner.
  //
  // Created lazily on the first add(), so a page that activates neither feature
  // gets no DOM at all.
  var DOCK_BTN_CSS = 'width:36px;height:36px;border-radius:8px;flex:none;' +
    'border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.14);' +
    'color:inherit;cursor:pointer;font-size:14px;line-height:1;display:flex;' +
    'align-items:center;justify-content:center;padding:0';
  var dock = (function () {
    // Key predates the dock: a user who already dragged the lone theme button
    // keeps that choice instead of silently getting reset to the default corner.
    var CORNER_KEY = 'htmlapp-theme-corner';   // 'tl' | 'tr' | 'bl' | 'br'
    var CORNER_MARGIN = 10;
    var corner = 'tr';                          // default = the historic position
    try {
      var storedCorner = localStorage.getItem(CORNER_KEY);
      if (storedCorner === 'tl' || storedCorner === 'tr' ||
          storedCorner === 'bl' || storedCorner === 'br') corner = storedCorner;
    } catch (e) {}

    var el = null;
    var queued = [];
    var watchers = [];

    var applyCorner = function () {
      if (el) {
        var s = el.style;
        var atTop = corner.charAt(0) === 't';
        var atLeft = corner.charAt(1) === 'l';
        s.top = atTop ? CORNER_MARGIN + 'px' : 'auto';
        s.bottom = atTop ? 'auto' : CORNER_MARGIN + 'px';
        s.left = atLeft ? CORNER_MARGIN + 'px' : 'auto';
        s.right = atLeft ? 'auto' : CORNER_MARGIN + 'px';
      }
      for (var i = 0; i < watchers.length; i++) {
        try { watchers[i](corner); } catch (e) {}
      }
    };

    var dragging = false;   // past the slop threshold for THIS gesture
    var didDrag = false;    // a drag happened -> swallow the trailing click
    var held = null;        // element holding the pointer capture; see pointerdown
    var startX = 0, startY = 0, grabX = 0, grabY = 0;

    var build = function () {
      el = document.createElement('div');
      // touch-action:none — the drag is pointer-driven, so the browser must not
      // also treat the gesture as a scroll. Without it a touch-drag inside an
      // iframe can scroll-chain to the Cockpit shell behind it.
      el.style.cssText = 'position:fixed;z-index:2147483647;display:flex;' +
        'flex-direction:column;gap:8px;touch-action:none';
      applyCorner();

      // Pointer LISTENERS sit on the container (one set for every button), but
      // the CAPTURE has to stay on the pressed button: per Pointer Events, a
      // click is dispatched to the capture target, so capturing on the container
      // silently eats every button click — the buttons render and do nothing.
      // Capturing the child instead keeps click on the button, and the moves it
      // now receives still bubble up to these listeners.
      el.addEventListener('pointerdown', function (ev) {
        if (ev.button) return;                 // primary button / touch / pen only
        dragging = false;
        didDrag = false;                       // reset here, so a swallowed click
                                               // can never leak into the next press
        startX = ev.clientX; startY = ev.clientY;
        var r = el.getBoundingClientRect();
        grabX = ev.clientX - r.left; grabY = ev.clientY - r.top;
        var target = ev.target && ev.target.setPointerCapture ? ev.target : el;
        held = null;
        // No capture (or a refused one) just means no drag this gesture — the
        // click still works, which is the one thing that must never break.
        try { target.setPointerCapture(ev.pointerId); held = target; } catch (e) {}
      });

      el.addEventListener('pointermove', function (ev) {
        if (!held || !held.hasPointerCapture || !held.hasPointerCapture(ev.pointerId)) return;
        if (!dragging) {
          // Slop before a press becomes a drag: a finger never holds as still as
          // a mouse, so touch needs the looser threshold or taps turn into drags.
          var slop = ev.pointerType === 'touch' ? 8 : 5;
          if (Math.abs(ev.clientX - startX) < slop &&
              Math.abs(ev.clientY - startY) < slop) return;
          dragging = true; didDrag = true;
        }
        ev.preventDefault();
        var s = el.style;
        s.right = 'auto'; s.bottom = 'auto';   // free-float while held
        s.left = (ev.clientX - grabX) + 'px';
        s.top = (ev.clientY - grabY) + 'px';
      });

      var release = function (ev) {
        if (!held) return;
        try { held.releasePointerCapture(ev.pointerId); } catch (e) {}
        held = null;
      };

      el.addEventListener('pointerup', function (ev) {
        release(ev);
        if (!dragging) return;
        dragging = false;
        var r = el.getBoundingClientRect();
        corner = ((r.top + r.height / 2) < window.innerHeight / 2 ? 't' : 'b') +
                 ((r.left + r.width / 2) < window.innerWidth / 2 ? 'l' : 'r');
        try { localStorage.setItem(CORNER_KEY, corner); } catch (e) {}
        applyCorner();
      });

      el.addEventListener('pointercancel', function (ev) {
        dragging = false;
        release(ev);
        applyCorner();                         // snap back rather than strand it
      });

      // Capture phase on the container, so the click that trails a drag is
      // swallowed BEFORE it reaches the button it was released over. Buttons
      // keep plain click handlers, so keyboard activation still toggles.
      el.addEventListener('click', function (ev) {
        if (!didDrag) return;
        didDrag = false;
        ev.stopPropagation();
        ev.preventDefault();
      }, true);

      window.addEventListener('resize', applyCorner);
      document.body.appendChild(el);
    };

    var flush = function () {
      if (!document.body) return;              // retried on DOMContentLoaded
      if (!el) build();
      for (var i = 0; i < queued.length; i++) el.appendChild(queued[i]);
      queued = [];
    };
    document.addEventListener('DOMContentLoaded', flush);

    return {
      // The order fixes the slot regardless of WHEN a button is added — the theme
      // toggle waits for DOMContentLoaded, the log button for the page's first
      // bash call, so append order alone would shuffle them around.
      add: function (node, order) {
        node.style.order = String(order);
        queued.push(node);
        flush();
      },
      corner: function () { return corner; },
      // Panels anchored to the dock re-place themselves on every corner change.
      watch: function (fn) { watchers.push(fn); }
    };
  })();

  // Host theme, tracked UNCONDITIONALLY — deliberately separate from the opt-in
  // theme block below. Host chrome (the call-log panel) has to match Cockpit on
  // EVERY previewed page, but the .dark class is only maintained for pages that
  // declared <meta name="cockpit-theme">, which most previewed files never do.
  // Reading the class alone would leave the panel stuck dark on a light page.
  var hostDark = null;      // null = the host has not told us anything yet
  var themeActive = false;  // page opted into theming -> .dark is authoritative
  window.addEventListener('message', function (ev) {
    var d = ev && ev.data;
    if (!d || d.type !== 'THEME_CHANGE') return;
    hostDark = d.theme === 'dark' || (d.theme === 'system' &&
      !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
    applyAuditTheme();
  });

  // Effective dark/light for host chrome: the page's own theme when it opted in
  // (so its toggle — and any stored per-app choice — drives the panel too), else
  // whatever the host last pushed, else the OS preference.
  function chromeDark() {
    try {
      if (themeActive) return document.documentElement.classList.contains('dark');
      if (hostDark !== null) return hostDark;
      return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
    } catch (e) { return false; }
  }

  // Theme — OPT-IN. The floating toggle + any .dark class management
  // happen ONLY when the page declares <meta name="cockpit-theme" content="...">.
  // Rationale: injection is by file type, not by SDK usage, so plain one-off pages
  // (notes, reports) with no dark styling used to get a dead button that toggled a
  // .dark class nothing responds to. Requiring an explicit opt-in marker keeps the
  // button off those pages, while apps that provide :root/.dark tokens just add the
  // meta to get a free host-managed toggle — no per-app button code needed.
  //   content="auto"  → first load with no stored choice follows the OS preference
  //   content="light" → first load defaults to light (still user-toggleable)
  //   content="dark"  → first load defaults to dark
  // The user's explicit toggle is REMEMBERED per app (key namespaced by cockpit-name,
  // else page path) across reloads, and wins over the content default on next load.
  // localStorage is SHARED with Cockpit + every other app, hence the namespaced key.
  // Apps can also drive it programmatically via window.cockpit.toggleTheme().
  var toggleTheme = function () {};
  var initTheme = function () {
  try {
    var themeMeta = function (n) {
      var el = document.querySelector('meta[name="' + n + '"]');
      return el ? el.content : '';
    };
    var themeSetting = (themeMeta('cockpit-theme') || '').toLowerCase().trim();
    if (themeSetting) {
      themeActive = true;
      var themeKey = 'htmlapp-theme:' + (themeMeta('cockpit-name') || location.pathname);
      // Store the explicit choice both ways so it round-trips regardless of the
      // content default (a bare "store only dark" model would lose a user's light
      // choice under content="auto" on a dark OS).
      var themeStore = function (d) {
        try { localStorage.setItem(themeKey, d ? 'dark' : 'light'); } catch (e) {}
      };
      var themeBtn = null;
      var setDark = function (d, persist) {
        document.documentElement.classList.toggle('dark', !!d);
        if (persist) themeStore(!!d);
        if (themeBtn) themeBtn.textContent = d ? '☀️' : '\u{1F319}';
        applyAuditTheme();   // host chrome follows the page it is sitting on
      };
      toggleTheme = function () {
        setDark(!document.documentElement.classList.contains('dark'), true);
      };
      // Init: remembered user choice wins; else the content default; "auto" follows OS.
      var stored = null;
      try { stored = localStorage.getItem(themeKey); } catch (e) {}
      var initDark;
      if (stored === 'dark' || stored === 'light') initDark = stored === 'dark';
      else if (themeSetting === 'dark') initDark = true;
      else if (themeSetting === 'auto') initDark = !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches);
      else initDark = false; // light / unknown
      setDark(initDark, false);
      // Follow the Cockpit host theme by default: the console bubble pushes a
      // THEME_CHANGE on iframe load and ThemeProvider broadcasts it on toggle.
      // An explicit per-app user choice (stored) always wins over the host.
      window.addEventListener('message', function (ev) {
        var d = ev && ev.data;
        if (!d || d.type !== 'THEME_CHANGE') return;
        var userChoice = null;
        try { userChoice = localStorage.getItem(themeKey); } catch (e) {}
        if (userChoice === 'dark' || userChoice === 'light') return;
        var hostDark = d.theme === 'dark' || (d.theme === 'system' &&
          !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
        setDark(hostDark, false);
      });
      // Positioning, dragging and corner memory all belong to the dock — this
      // button only has to look like one and say what it does.
      themeBtn = document.createElement('button');
      themeBtn.type = 'button';
      themeBtn.setAttribute('aria-label', 'Toggle theme');
      themeBtn.textContent = document.documentElement.classList.contains('dark') ? '☀️' : '\u{1F319}';
      themeBtn.style.cssText = DOCK_BTN_CSS;
      // A click handler rather than pointerup, so keyboard activation
      // (Enter/Space on the focused button) still toggles. The click that
      // trails a drag is swallowed by the dock before it gets here.
      themeBtn.onclick = function () { toggleTheme(); };
      dock.add(themeBtn, 0);
    }
  } catch (e) {}
  };
  // This script is injected at the START of <head>, BEFORE the page's own
  // <meta> tags are parsed — reading them synchronously here always misses
  // them. Defer theme init until the DOM is ready so the opt-in meta is seen.
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', initTheme);
  else initTheme();

  var CWD = __CWD__;
  var WS_URL = __WS_URL__;

  var ws = null;
  var ready = false;
  var queue = [];          // [{ id, s }] — pending frames, drained on open
  var handlers = {};       // id -> { onStdout, onStderr, onExit, onError, gen }
  var seq = 0;
  var gen = 0;             // connection generation; see ensureWs

  function resolveWsUrl() {
    if (WS_URL) return WS_URL;
    var proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    return proto + '//' + location.host + '/ws/bash?cwd=' + encodeURIComponent(CWD);
  }

  function failAll(reason) {
    var ids = Object.keys(handlers);
    for (var i = 0; i < ids.length; i++) {
      var h = handlers[ids[i]];
      delete handlers[ids[i]];
      if (h && h.onError) h.onError(reason);
    }
  }

  /**
   * Fail only the commands carried by ONE connection. Handlers are tagged with
   * the generation of the socket that actually wrote them, so a socket that has
   * been replaced can report its own losses without touching its successor's
   * in-flight work.
   */
  function failGen(g, reason) {
    var ids = Object.keys(handlers);
    for (var i = 0; i < ids.length; i++) {
      var h = handlers[ids[i]];
      if (!h || h.gen !== g) continue;
      delete handlers[ids[i]];
      if (h.onError) h.onError(reason);
    }
  }

  function ensureWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    // A socket in CLOSING(2) is replaced here rather than waited on, so two
    // sockets can briefly coexist. Shared state (\`ready\`, \`queue\`) may only
    // be touched by the CURRENT socket — otherwise a replaced socket's late
    // onclose flips \`ready\` to false while its successor is already open, and
    // since the successor's onopen has long since fired nothing ever sets it
    // back: every later bash() then queues forever with no error at all.
    var myGen = ++gen;
    var sock;
    try { sock = new WebSocket(resolveWsUrl()); }
    catch (e) { failAll(String(e)); return; }
    ws = sock;
    ready = false;
    sock.onopen = function () {
      if (ws !== sock) return;
      ready = true;
      var q = queue; queue = [];
      for (var i = 0; i < q.length; i++) {
        // Re-tag: this socket, not the one queued them, is the carrier.
        if (handlers[q[i].id]) handlers[q[i].id].gen = myGen;
        sock.send(q[i].s);
      }
    };
    // NOT generation-guarded: ids are globally unique, so a late frame can only
    // belong to the command this very socket carried. Dropping it would leave
    // that command's promise unsettled forever.
    sock.onmessage = function (ev) {
      var msg;
      try { msg = JSON.parse(ev.data); } catch (e) { return; }
      if (msg.type === 'ping') return;
      var h = handlers[msg.id];
      if (!h) return;
      if (msg.type === 'stdout') { if (h.onStdout) h.onStdout(msg.data); }
      else if (msg.type === 'stderr') { if (h.onStderr) h.onStderr(msg.data); }
      else if (msg.type === 'exit') { delete handlers[msg.id]; if (h.onExit) h.onExit(msg.code); }
      else if (msg.type === 'error') { delete handlers[msg.id]; if (h.onError) h.onError(msg.message); }
    };
    sock.onclose = function () {
      if (ws === sock) {
        ready = false;
        // Drop anything still queued and fail it here. These are shell commands
        // with side effects: letting a later reconnect drain this queue would
        // re-run them with their handlers already gone, so the output would go
        // nowhere and the caller would never learn it ran twice.
        var q = queue; queue = [];
        for (var i = 0; i < q.length; i++) {
          var qh = handlers[q[i].id];
          if (!qh) continue;
          delete handlers[q[i].id];
          if (qh.onError) qh.onError('connection closed');
        }
      }
      // Always report THIS connection's own losses, current or replaced — a
      // replaced socket still owes an answer to whatever it was carrying.
      failGen(myGen, 'connection closed');
    };
    sock.onerror = function () { /* onclose follows */ };
  }

  function send(obj) {
    var s = JSON.stringify(obj);
    ensureWs();
    // Tag AFTER ensureWs — it may have opened a new connection, and what
    // matters is which socket ends up carrying this command.
    if (obj.id && handlers[obj.id]) handlers[obj.id].gen = gen;
    if (ready && ws && ws.readyState === 1) ws.send(s);
    else queue.push({ id: obj.id, s: s });
  }

  // ── Bash call log ─────────────────────────────────────────────────────────
  // Every bash() the page issues is recorded and shown in a floating panel, so
  // the user can audit what a previewed page actually ran. Previewing a local
  // .html RUNS it, with full shell access, and until now that happened with no
  // trace anywhere: /ws/bash deliberately stays out of terminal history and logs
  // only the cwd of a connection, never a command.
  //
  // NOT opt-in via <meta>, unlike the theme toggle: a page that could switch the
  // log off by omitting a tag would simply omit it. Instead the button stays
  // hidden until the page's FIRST bash call — so a plain note/report still gets
  // no chrome, and the button appearing is itself the signal that this page ran
  // something.
  //
  // In memory, per page: a reload clears the log, and so does the panel's Clear
  // button. NOT localStorage — that store is shared with Cockpit and writable by
  // the page, so a persisted log would be forgeable by the very code it audits.
  // Nothing is exposed on window.cockpit for the same reason: this is host
  // chrome reporting on the page, not a feature the page gets to drive.
  var AUDIT_MAX = 300;      // ring bound — a page can call bash() in a loop
  // Two palettes, applied as custom properties on the panel: every descendant
  // reads var(--cpk-*), so a theme flip is one property write instead of a
  // re-render, and rows built earlier restyle themselves.
  var AUDIT_THEME = {
    dark: {
      bg: 'rgba(28,28,30,.97)', fg: '#e8e8ea', bd: 'rgba(255,255,255,.14)',
      line: 'rgba(255,255,255,.09)', btn: 'rgba(255,255,255,.22)',
      shadow: '0 8px 30px rgba(0,0,0,.45)',
      running: '#e0a648', exit: '#4ea774', error: '#e0605c', killed: '#8a8a8e'
    },
    light: {
      bg: 'rgba(255,255,255,.98)', fg: '#1c1c1e', bd: 'rgba(0,0,0,.16)',
      line: 'rgba(0,0,0,.09)', btn: 'rgba(0,0,0,.22)',
      shadow: '0 8px 30px rgba(0,0,0,.18)',
      // Darker than their dark-mode counterparts — the same green/amber that
      // reads well on near-black washes out entirely on near-white.
      running: '#9a6510', exit: '#2f7d52', error: '#c0392b', killed: '#6b6b70'
    }
  };
  var AUDIT_HEAD_BTN_CSS = 'border:1px solid var(--cpk-btn);background:transparent;' +
    'color:inherit;border-radius:6px;padding:2px 8px;font-size:11px;cursor:pointer;flex:none';
  var calls = [];
  var callIndex = {};       // id -> record, only while in flight
  var auditBtn = null, auditPanel = null, auditList = null, auditTitle = null;
  var auditOpen = false;

  function auditStart(id, command, cwd, background) {
    try {
      var rec = {
        command: String(command),
        cwd: cwd,
        background: !!background,
        startedAt: Date.now(),
        endedAt: 0,
        state: 'running',        // running | exit | error | killed
        code: null,
        message: ''
      };
      calls.push(rec);
      if (calls.length > AUDIT_MAX) calls.shift();
      callIndex[id] = rec;
      mountAuditBtn();
      renderAudit();
    } catch (e) {}
  }

  // The state is terminal once set: kill() settles the record itself, and a real
  // exit frame may still arrive afterwards for the same id.
  function auditSettle(id, state, detail) {
    try {
      var rec = callIndex[id];
      if (!rec) return;
      delete callIndex[id];
      if (rec.state !== 'running') return;
      rec.state = state;
      rec.endedAt = Date.now();
      if (state === 'exit') rec.code = detail;
      else if (detail != null) rec.message = String(detail);
      renderAudit();
    } catch (e) {}
  }

  function auditStatusText(rec) {
    if (rec.state === 'running') return 'running';
    if (rec.state === 'killed') return 'killed';
    if (rec.state === 'error') return rec.message ? 'error: ' + rec.message : 'error';
    return 'exit ' + rec.code;
  }

  function auditRow(rec) {
    var row = document.createElement('div');
    row.style.cssText = 'padding:8px 10px;border-top:1px solid var(--cpk-line)';
    var cmd = document.createElement('div');
    // textContent, never innerHTML — this string comes from the page being audited.
    cmd.textContent = rec.command;
    cmd.style.cssText = 'font-family:ui-monospace,SFMono-Regular,Menlo,monospace;' +
      'font-size:12px;line-height:1.45;white-space:pre-wrap;word-break:break-all';
    var bits = [];
    try { bits.push(new Date(rec.startedAt).toTimeString().slice(0, 8)); } catch (e) {}
    bits.push(auditStatusText(rec));
    if (rec.endedAt) bits.push(((rec.endedAt - rec.startedAt) / 1000).toFixed(2) + 's');
    if (rec.background) bits.push('background');
    // Only when it differs from the page's own cwd — otherwise it is noise on
    // every single row.
    if (rec.cwd && rec.cwd !== CWD) bits.push(rec.cwd);
    var bad = rec.state === 'error' || (rec.state === 'exit' && rec.code !== 0);
    var meta = document.createElement('div');
    meta.textContent = bits.join('  ·  ');
    meta.style.cssText = 'margin-top:3px;font-size:11px;color:var(--cpk-' +
      (bad ? 'error' : rec.state) + ')';
    row.appendChild(cmd);
    row.appendChild(meta);
    return row;
  }

  // Records accumulate whether or not anyone is looking; this only paints, and
  // a closed panel is repainted once on open instead. That is not a micro
  // optimization: a page can call bash() in a loop, and rebuilding every row per
  // call behind a hidden panel is quadratic work for nobody.
  function renderAudit() {
    if (!auditPanel || !auditOpen) return;
    auditTitle.textContent = 'Bash calls (' + calls.length + ')';
    while (auditList.firstChild) auditList.removeChild(auditList.firstChild);
    if (!calls.length) {
      var empty = document.createElement('div');
      empty.style.cssText = 'padding:14px 10px;font-size:12px;opacity:.6';
      empty.textContent = 'No calls recorded.';
      auditList.appendChild(empty);
      return;
    }
    // Newest first: the reason to open this panel is almost always "what did it
    // just run".
    for (var i = calls.length - 1; i >= 0; i--) auditList.appendChild(auditRow(calls[i]));
  }

  // Called on every host theme change, including before the panel exists.
  function applyAuditTheme() {
    if (!auditPanel) return;
    var tone = AUDIT_THEME[chromeDark() ? 'dark' : 'light'];
    for (var k in tone) auditPanel.style.setProperty('--cpk-' + k, tone[k]);
  }

  function placeAuditPanel() {
    if (!auditPanel) return;
    var c = dock.corner();
    var s = auditPanel.style;
    var atTop = c.charAt(0) === 't';
    var atLeft = c.charAt(1) === 'l';
    s.top = atTop ? '10px' : 'auto';
    s.bottom = atTop ? 'auto' : '10px';
    // 56px = dock margin (10) + button (36) + gap (10): beside the dock, never
    // under it, on whichever side the dock currently sits.
    s.left = atLeft ? '56px' : 'auto';
    s.right = atLeft ? 'auto' : '56px';
  }

  function buildAuditPanel() {
    auditPanel = document.createElement('div');
    // z-index one below the dock, so the panel can never bury its own toggle.
    auditPanel.style.cssText = 'position:fixed;z-index:2147483646;width:380px;' +
      'max-width:calc(100vw - 76px);max-height:60vh;display:none;flex-direction:column;' +
      'background:var(--cpk-bg);color:var(--cpk-fg);border:1px solid var(--cpk-bd);' +
      'border-radius:10px;box-shadow:var(--cpk-shadow);overflow:hidden;' +
      'font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif';
    applyAuditTheme();
    var head = document.createElement('div');
    head.style.cssText = 'display:flex;align-items:center;gap:8px;padding:8px 10px;flex:none;' +
      'border-bottom:1px solid var(--cpk-line);font-size:12px';
    auditTitle = document.createElement('div');
    auditTitle.style.cssText = 'flex:1;font-weight:600';
    var clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.textContent = 'Clear';
    clearBtn.style.cssText = AUDIT_HEAD_BTN_CSS;
    clearBtn.onclick = function () {
      // Still-running calls survive the clear: they have no result yet, and
      // dropping their rows would make a command that is at this moment
      // executing look like it never happened.
      var keep = [];
      for (var i = 0; i < calls.length; i++) {
        if (calls[i].state === 'running') keep.push(calls[i]);
      }
      calls = keep;
      renderAudit();
    };
    var closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.textContent = '✕';
    closeBtn.setAttribute('aria-label', 'Close');
    closeBtn.style.cssText = AUDIT_HEAD_BTN_CSS;
    closeBtn.onclick = function () { setAuditOpen(false); };
    head.appendChild(auditTitle);
    head.appendChild(clearBtn);
    head.appendChild(closeBtn);
    auditList = document.createElement('div');
    auditList.style.cssText = 'overflow:auto;flex:1';
    auditPanel.appendChild(head);
    auditPanel.appendChild(auditList);
    placeAuditPanel();
    dock.watch(placeAuditPanel);
    document.body.appendChild(auditPanel);
  }

  function setAuditOpen(open) {
    auditOpen = !!open;
    if (auditOpen && !auditPanel) buildAuditPanel();
    if (auditPanel) auditPanel.style.display = auditOpen ? 'flex' : 'none';
    if (auditBtn) auditBtn.setAttribute('aria-expanded', auditOpen ? 'true' : 'false');
    if (auditOpen) renderAudit();
  }

  function mountAuditBtn() {
    if (auditBtn) return;
    auditBtn = document.createElement('button');
    auditBtn.type = 'button';
    auditBtn.setAttribute('aria-label', 'Bash call log');
    auditBtn.setAttribute('aria-expanded', 'false');
    auditBtn.title = 'Bash call log';
    auditBtn.textContent = '\u{1F4DC}';
    auditBtn.style.cssText = DOCK_BTN_CSS;
    auditBtn.onclick = function () { setAuditOpen(!auditOpen); };
    dock.add(auditBtn, 1);   // below the theme toggle, whichever mounts first
  }

  function run(command, opts) {
    opts = opts || {};
    var id = 'c' + (++seq);
    var cwd = opts.cwd || CWD;
    auditStart(id, command, cwd, opts.background);
    handlers[id] = {
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      // Settle the record BEFORE handing control to the app's own callback: a
      // callback that throws must not leave the log stuck showing "running".
      onExit: function (code) { auditSettle(id, 'exit', code); if (opts.onExit) opts.onExit(code); },
      onError: function (m) { auditSettle(id, 'error', m); if (opts.onError) opts.onError(m); }
    };
    send({ type: 'exec', id: id, command: command, cwd: cwd });
    return id;
  }

  function bash(command, opts) {
    opts = opts || {};
    if (opts.background) {
      var id = run(command, {
        cwd: opts.cwd,
        background: true,
        onStdout: opts.onOutput,
        onStderr: opts.onStderr || opts.onOutput,
        onExit: opts.onExit,
        onError: opts.onError
      });
      return { kill: function () {
        send({ type: 'kill', id: id });
        delete handlers[id];
        // Settle here rather than waiting for the exit frame: the handler is
        // gone, so nothing else will ever settle this record.
        auditSettle(id, 'killed');
      } };
    }
    return new Promise(function (resolve, reject) {
      var out = '', err = '';
      run(command, {
        cwd: opts.cwd,
        onStdout: function (d) { out += d; },
        onStderr: function (d) { err += d; },
        onExit: function (code) { resolve({ stdout: out, stderr: err, exitCode: code }); },
        onError: function (m) { reject(new Error(m)); }
      });
    });
  }

  // toggleTheme is reassigned by the deferred initTheme — forward lazily so the
  // exported function always calls the current implementation, not the no-op.
  window.cockpit = {
    cwd: CWD,
    bash: bash,
    toggleTheme: function () { toggleTheme(); },
    // Current host language ('' until the host's first push, so apps can fall
    // back to navigator themselves). Apps PERCEIVE the language and own their
    // own strings — this is not an i18n runtime.
    get lang() {
      return document.documentElement.getAttribute('data-cockpit-lang') || '';
    }
  };
  window.addEventListener('beforeunload', function () {
    try { if (ws) ws.close(); } catch (e) {}
  });
})();
`

// ── Bash cwd derivation (single source of truth) ────────────────────────────
// Both injection sites derive the previewed file's directory through this same
// helper, so the "make it absolute" logic can never drift:
//   - HtmlAppFrame (client): filePath is project-root-relative (explorer) or
//     absolute (chat); passes the absolute project root as `projectRoot`.
//   - the /apps route (server): passes its already-normalized absolute fullPath;
//     the isAbsolute branch degenerates to a plain dirname.
// Hand-rolled (no node `path`) so it stays importable from the browser bundle.

/** Directory portion of a path (posix or windows separators); '' for a bare name. */
function dirnameOf(p: string): string {
  const i = Math.max(p.lastIndexOf("/"), p.lastIndexOf("\\"))
  if (i < 0) return ""
  return i === 0 ? "/" : p.slice(0, i)
}

/** Absolute path? posix `/x`, windows `C:\x` or UNC `\\server`. */
export function isAbsolutePath(p: string): boolean {
  return /^([/\\]|[A-Za-z]:)/.test(p)
}

/** Join a base dir and a relative segment with a single separator. */
function joinPath(base: string, rel: string): string {
  const b = base.replace(/[/\\]+$/, "")
  return rel ? `${b}/${rel}` : b
}

/**
 * Resolve the ABSOLUTE working directory for a previewed file's bash commands.
 * When `filePath` is relative it is resolved against `projectRoot`; when it is
 * already absolute `projectRoot` is ignored. Returns a possibly-relative dir
 * only as a last resort (relative filePath with no projectRoot).
 */
export function resolveBashCwd(filePath: string, projectRoot?: string): string {
  const dir = dirnameOf(filePath)
  if (isAbsolutePath(filePath)) return dir
  return projectRoot ? joinPath(projectRoot, dir) : dir
}

/** True when an absolute file path is derivable from these inputs. */
export function canResolveAbsolute(filePath: string, projectRoot?: string): boolean {
  return isAbsolutePath(filePath) || !!projectRoot
}

/** Address space for local files inside the unified /apps runtime. */
export const LOCAL_APP_PREFIX = "/apps/local/"
/** Address space for apps shipped in the package's `apps/` directory. */
export const BUILTIN_APP_PREFIX = "/apps/builtin/"

/**
 * Map a local file path to its `/apps/local/<encoded-abs-path>` URL (static-site
 * style: relative siblings, images, and CDN refs all resolve). Relative
 * `filePath` is resolved against `projectRoot`. Single source of truth for both
 * the console browser bubble and the HTML preview.
 */
export function toLocalAppUrl(filePath: string, projectRoot?: string): string {
  const trimmed = filePath.trim()
  const abs = isAbsolutePath(trimmed)
    ? trimmed
    : joinPath(projectRoot ?? "", trimmed)
  // Normalize Windows separators to `/` so the URL is properly segmented. A
  // Windows absolute path (C:\Users\x) has no `/` — without this the whole path
  // becomes one blob-encoded segment and loses the prefix separator. Always
  // emit exactly one slash between the prefix and the (possibly drive-lettered)
  // path, so both `/Users/x` and `C:/Users/x` are well-formed.
  const encoded = abs
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/^\//, "")
  // No SDK marker in the URL: the document declares it itself via
  // <meta name="cockpit-name"> (see apps.ts). A query flag did not survive
  // navigation — a form GET with an empty action rewrites the query string,
  // so the page came back without window.cockpit and every button then threw.
  return LOCAL_APP_PREFIX + encoded
}

/**
 * Collapse `.` / `..` segments (posix or windows separators). Leading `..`
 * that would escape an absolute root are dropped, as the OS does for `/..`.
 */
function normalizeSegments(p: string): string {
  const drive = /^[A-Za-z]:/.exec(p)?.[0] ?? ""
  const body = drive ? p.slice(drive.length) : p
  const rooted = /^[/\\]/.test(body)
  const out: string[] = []
  for (const seg of body.split(/[/\\]/)) {
    if (!seg || seg === ".") continue
    if (seg === "..") {
      if (out.length && out[out.length - 1] !== "..") out.pop()
      else if (!rooted && !drive) out.push("..")
      continue
    }
    out.push(seg)
  }
  return drive + (rooted || drive ? "/" : "") + out.join("/")
}

/**
 * A reference the browser already resolves on its own: any scheme (`http:`,
 * `data:`), protocol-relative `//host`, or root-relative `/path`.
 */
const SELF_RESOLVING_REF_RE = /^([a-z][a-z0-9+.-]*:|\/\/|\/)/i

/**
 * Resolve a document-relative media reference (markdown `![](x)`, raw
 * `<img src="x">`) against the directory the document itself lives in, and map
 * it to the `/apps/local` URL that actually serves those bytes.
 *
 * This is the base-URL the renderer otherwise lacks: markdown is rendered
 * detached from its address, so a relative src would resolve against the app's
 * page URL and 404 (root-relative paths are not served — see apps.ts). Rather
 * than rewriting the markdown SOURCE (which corrupts image syntax quoted inside
 * fenced code blocks and misses reference-style images), callers hand the base
 * to the renderer and resolution happens per-reference, at render time.
 *
 * Returns `src` untouched when it is already self-resolving or when no absolute
 * base is derivable — a wrong URL is worse than the browser's own attempt.
 */
export function resolveLocalMediaUrl(
  src: string,
  baseDir: string,
  projectRoot?: string
): string {
  const raw = src.trim()
  if (!raw || SELF_RESOLVING_REF_RE.test(raw)) return src
  // canResolveAbsolute, not isAbsolutePath(joined): joinPath("", "docs") yields
  // "/docs", which would pass an absolute-path test and silently anchor a
  // relative base to the filesystem ROOT.
  if (!canResolveAbsolute(baseDir, projectRoot)) return src
  const base = isAbsolutePath(baseDir)
    ? baseDir
    : joinPath(projectRoot as string, baseDir)

  // Split `?query` / `#hash` off BEFORE building the path: toLocalAppUrl encodes
  // per segment, so a suffix left attached is percent-escaped INTO the filename
  // (`logo.png?v=2` -> `logo.png%3Fv%3D2`) and 404s. Cache-busting queries and
  // SVG fragment ids are ordinary markdown, so this is not an edge case.
  const cut = raw.search(/[?#]/)
  const rel = cut < 0 ? raw : raw.slice(0, cut)
  const suffix = cut < 0 ? "" : raw.slice(cut)
  if (!rel) return src // bare `#frag` / `?q` — not a path reference

  // The source carries an already-encoded path (`my%20file.png`) and
  // toLocalAppUrl re-encodes per segment; decode first or it becomes `%2520`.
  let decoded = rel
  try {
    decoded = decodeURIComponent(rel)
  } catch {
    /* malformed escape — use the path as written */
  }

  // `..` MUST be collapsed here: fromLocalAppUrl rejects a URL still containing
  // a `..` segment as a traversal attempt, so an un-normalized `../img.png`
  // would come back 403 instead of the file one directory up.
  return toLocalAppUrl(normalizeSegments(joinPath(base, decoded))) + suffix
}

/**
 * Extensions handled by the built-in file-viewer app (apps/file-viewer/):
 * markdown (CockpitMarkdown + TocSidebar), images (themed, centered, fit/100%
 * toggle), pdf (CockpitPdf, Explorer's themed viewer), json (readable widget
 * with a raw-source toggle), csv/tsv (CockpitCsv table with a raw-source
 * toggle).
 */
const FILE_VIEWER_EXT_RE = /\.(md|png|jpe?g|gif|webp|svg|pdf|json|csv|tsv)$/i

/** True for a local file path the console routes to the file-viewer app. */
export function isFileViewerPath(filePath: string): boolean {
  return FILE_VIEWER_EXT_RE.test(filePath.trim())
}

/**
 * Map a local file path to the built-in file-viewer app
 * (`/apps/builtin/file-viewer/index.html?file=<abs>`). Same relative path
 * resolution as toLocalAppUrl. The `file` query param also tells the route
 * which directory to use as the injected SDK cwd; the viewer then reads the
 * content through cockpit.bash like any user-authored app.
 *
 * `index.html` is spelled out on purpose: a directory URL would hit Next's
 * trailingSlash redirect (`/apps/builtin/file-viewer/` -> no trailing slash),
 * after which the shell's relative `./app.jsx` fetch resolves one level too
 * high and 404s.
 */
export function toFileViewerUrl(filePath: string, projectRoot?: string): string {
  const trimmed = filePath.trim()
  const abs = isAbsolutePath(trimmed)
    ? trimmed
    : joinPath(projectRoot ?? "", trimmed)
  // No SDK marker here either — file-viewer/index.html declares
  // <meta name="cockpit-name"> like any other app; built-in gets no exemption.
  // `file` stays a query param: it is per-open context (which file this viewer
  // was launched for), not a property of the document, so it cannot live in the
  // head. It is therefore still lost across an in-app navigation, after which
  // the SDK cwd falls back to the app's own directory.
  return (
    BUILTIN_APP_PREFIX +
    "file-viewer/index.html?file=" +
    encodeURIComponent(abs.replace(/\\/g, "/"))
  )
}

/**
 * Convert an app-runtime URL for an external browser tab.
 *
 * Chrome 139+ navigation capture routes in-scope localhost URLs to an installed
 * PWA before the page ever loads. `/apps/*` has to remain same-origin inside
 * Cockpit iframes for SDK and selection access, but an explicit "open in
 * browser" action should bypass the localhost PWA scope. `127.0.0.1` reaches
 * the same dev server while being a different origin from `localhost`.
 */
export function toExternalBrowserAppUrl(appUrl: string, origin: string): string {
  try {
    const url = new URL(appUrl, origin)
    if (!url.pathname.startsWith(BUILTIN_APP_PREFIX) && !url.pathname.startsWith(LOCAL_APP_PREFIX)) {
      return appUrl
    }
    if (url.hostname === "localhost") {
      url.hostname = "127.0.0.1"
    }
    return url.toString()
  } catch {
    return appUrl
  }
}

/**
 * Reverse of toLocalAppUrl: `/apps/local/<encoded-abs>` → the absolute file path
 * (with `/` separators; node `path` on the server accepts `/` on Windows too).
 * Returns null on a path-traversal attempt or a NUL byte. The caller still runs
 * path.normalize + a filesystem stat.
 */
export function fromLocalAppUrl(pathname: string): string | null {
  const rest = pathname.startsWith(LOCAL_APP_PREFIX)
    ? pathname.slice(LOCAL_APP_PREFIX.length)
    : pathname.replace(/^\/+/, "")
  // toLocalAppUrl encodes per-segment, so a single decode restores the path.
  // A malformed escape (bare `%`) makes decodeURIComponent throw — report it
  // through the same null channel as a traversal attempt rather than letting it
  // escape as a defect and surface as a 500.
  let decoded: string
  try {
    decoded = decodeURIComponent(rest)
  } catch {
    return null
  }
  let raw = "/" + decoded
  // Windows drive path arrives as `/C:/Users/..`; drop the leading slash the
  // posix scheme prepends, else path.win32.normalize yields an invalid `\C:\..`.
  raw = raw.replace(/^\/([A-Za-z]:)/, "$1")
  // Traversal guard on BOTH separators — Windows paths use `\`.
  if (raw.includes("\0") || raw.split(/[/\\]/).includes("..")) return null
  return raw
}

export interface BashSdkOptions {
  /** Working directory for bash commands (the previewed file's directory). */
  cwd: string
  /**
   * Absolute ws(s):// URL of the /ws/bash endpoint (incl. the cwd query).
   * Required for srcDoc iframes (origin `about:srcdoc`); leave empty ("") for
   * real-URL iframes so the SDK derives the endpoint from window.location.
   */
  wsUrl?: string
}

/**
 * Return `html` with the cockpit bash SDK `<script>` injected at the start of
 * `<head>` (or prepended if there is no head). The injected script is inert
 * until the page calls `cockpit.bash(...)`.
 */
export function injectBashSdk(html: string, opts: BashSdkOptions): string {
  // Neutralize a literal `</script>` (or `</` generally) inside the baked cwd /
  // wsUrl so a path containing it can't break out of the injected <script>.
  const enc = (s: string) => JSON.stringify(s).replace(/</g, "\\u003c")
  const script =
    "<script>" +
    SDK_SOURCE.replaceAll("__CWD__", enc(opts.cwd)).replaceAll(
      "__WS_URL__",
      enc(opts.wsUrl ?? "")
    ) +
    "</script>"

  const headMatch = html.match(/<head[^>]*>/i)
  if (headMatch && headMatch.index !== undefined) {
    const at = headMatch.index + headMatch[0].length
    return html.slice(0, at) + script + html.slice(at)
  }
  // No <head>: insert after the <html> open tag if present (avoid landing before
  // the doctype, which triggers quirks mode); else prepend.
  const htmlMatch = html.match(/<html[^>]*>/i)
  if (htmlMatch && htmlMatch.index !== undefined) {
    const at = htmlMatch.index + htmlMatch[0].length
    return html.slice(0, at) + script + html.slice(at)
  }
  return script + html
}
