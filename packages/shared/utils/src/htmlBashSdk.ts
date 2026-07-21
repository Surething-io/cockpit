/**
 * htmlBashSdk — the `window.cockpit` bash SDK injected into previewed HTML.
 *
 * Two injection sites share this single source of truth:
 *   - HtmlPreview (client, srcDoc iframe): explorer file preview + chat preview.
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
 * too. The button is draggable and snaps to the nearest of the 4 corners, so it
 * can be moved off whatever the app puts under it; the corner is global.
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

  // Theme — OPT-IN. The floating top-right toggle + any .dark class management
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
      // The button is DRAGGABLE and snaps to whichever of the 4 viewport corners
      // it was released nearest to. A fixed corner is unworkable: the host picks
      // the spot, the app owns the content, and any app with its own top-right
      // affordance (close button, toolbar, TOC) had it permanently covered with
      // no escape. The chosen corner is remembered GLOBALLY (not per app) — one
      // gesture then holds for every HTML app, which is the common case since
      // apps tend to crowd the same corner.
      var CORNER_KEY = 'htmlapp-theme-corner';   // 'tl' | 'tr' | 'bl' | 'br'
      var CORNER_MARGIN = 10;
      var corner = 'tr';                          // default = the historic position
      try {
        var storedCorner = localStorage.getItem(CORNER_KEY);
        if (storedCorner === 'tl' || storedCorner === 'tr' ||
            storedCorner === 'bl' || storedCorner === 'br') corner = storedCorner;
      } catch (e) {}
      // Only the CORNER is persisted, never pixels: on resize/rotate a remembered
      // coordinate can land off-screen, while a corner is always re-derivable.
      var applyCorner = function () {
        if (!themeBtn) return;
        var s = themeBtn.style;
        var atTop = corner.charAt(0) === 't';
        var atLeft = corner.charAt(1) === 'l';
        s.top = atTop ? CORNER_MARGIN + 'px' : 'auto';
        s.bottom = atTop ? 'auto' : CORNER_MARGIN + 'px';
        s.left = atLeft ? CORNER_MARGIN + 'px' : 'auto';
        s.right = atLeft ? 'auto' : CORNER_MARGIN + 'px';
      };
      var mountThemeBtn = function () {
        if (themeBtn || !document.body) return;
        themeBtn = document.createElement('button');
        themeBtn.type = 'button';
        themeBtn.setAttribute('aria-label', 'Toggle theme');
        themeBtn.textContent = document.documentElement.classList.contains('dark') ? '☀️' : '\u{1F319}';
        // touch-action:none — the drag is pointer-driven, so the browser must not
        // also treat the gesture as a scroll. Without it a touch-drag inside an
        // iframe can scroll-chain to the Cockpit shell behind it.
        themeBtn.style.cssText = 'position:fixed;z-index:2147483647;width:36px;height:36px;' +
          'border-radius:8px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.14);' +
          'color:inherit;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;' +
          'justify-content:center;padding:0;touch-action:none';
        applyCorner();

        var dragging = false;   // past the slop threshold for THIS gesture
        var didDrag = false;    // a drag happened -> swallow the trailing click
        var startX = 0, startY = 0, grabX = 0, grabY = 0;

        themeBtn.addEventListener('pointerdown', function (ev) {
          if (ev.button) return;                 // primary button / touch / pen only
          dragging = false;
          didDrag = false;                       // reset here, so a swallowed click
                                                 // can never leak into the next press
          startX = ev.clientX; startY = ev.clientY;
          var r = themeBtn.getBoundingClientRect();
          grabX = ev.clientX - r.left; grabY = ev.clientY - r.top;
          try { themeBtn.setPointerCapture(ev.pointerId); } catch (e) {}
        });

        themeBtn.addEventListener('pointermove', function (ev) {
          if (!themeBtn.hasPointerCapture || !themeBtn.hasPointerCapture(ev.pointerId)) return;
          if (!dragging) {
            // Slop before a press becomes a drag: a finger never holds as still as
            // a mouse, so touch needs the looser threshold or taps turn into drags.
            var slop = ev.pointerType === 'touch' ? 8 : 5;
            if (Math.abs(ev.clientX - startX) < slop &&
                Math.abs(ev.clientY - startY) < slop) return;
            dragging = true; didDrag = true;
          }
          ev.preventDefault();
          var s = themeBtn.style;
          s.right = 'auto'; s.bottom = 'auto';   // free-float while held
          s.left = (ev.clientX - grabX) + 'px';
          s.top = (ev.clientY - grabY) + 'px';
        });

        var endDrag = function (ev) {
          try { themeBtn.releasePointerCapture(ev.pointerId); } catch (e) {}
          if (!dragging) return;
          dragging = false;
          var r = themeBtn.getBoundingClientRect();
          corner = ((r.top + r.height / 2) < window.innerHeight / 2 ? 't' : 'b') +
                   ((r.left + r.width / 2) < window.innerWidth / 2 ? 'l' : 'r');
          try { localStorage.setItem(CORNER_KEY, corner); } catch (e) {}
          applyCorner();
        };
        themeBtn.addEventListener('pointerup', endDrag);
        themeBtn.addEventListener('pointercancel', function (ev) {
          dragging = false;
          try { themeBtn.releasePointerCapture(ev.pointerId); } catch (e) {}
          applyCorner();                         // snap back rather than strand it
        });

        // Kept as a click handler rather than firing on pointerup so keyboard
        // activation (Enter/Space on the focused button) still toggles.
        themeBtn.onclick = function () {
          if (didDrag) { didDrag = false; return; }
          toggleTheme();
        };
        window.addEventListener('resize', applyCorner);
        document.body.appendChild(themeBtn);
      };
      if (document.body) mountThemeBtn();
      else window.addEventListener('DOMContentLoaded', mountThemeBtn);
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

  function run(command, opts) {
    opts = opts || {};
    var id = 'c' + (++seq);
    handlers[id] = {
      onStdout: opts.onStdout,
      onStderr: opts.onStderr,
      onExit: opts.onExit,
      onError: opts.onError
    };
    send({ type: 'exec', id: id, command: command, cwd: opts.cwd || CWD });
    return id;
  }

  function bash(command, opts) {
    opts = opts || {};
    if (opts.background) {
      var id = run(command, {
        cwd: opts.cwd,
        onStdout: opts.onOutput,
        onStderr: opts.onStderr || opts.onOutput,
        onExit: opts.onExit,
        onError: opts.onError
      });
      return { kill: function () { send({ type: 'kill', id: id }); delete handlers[id]; } };
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
//   - HtmlPreview (client): filePath is project-root-relative (explorer) or
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
  // `?bash=1` → the /apps route injects the window.cockpit bash SDK. Every
  // caller here is a deliberate user gesture (explorer preview button,
  // console-typed path / `/name` app), so the flag is unconditional. The
  // server-side gate still matters: relative sub-resources loaded FROM a page
  // (./app.jsx, nested html) arrive without the query and are served raw — SDK
  // injection stays scoped to top-level, user-opened documents. The hard
  // enforcement is the /ws/bash same-origin gate either way.
  return LOCAL_APP_PREFIX + encoded + "?bash=1"
}

/**
 * Extensions handled by the built-in file-viewer app (apps/file-viewer/):
 * markdown (CockpitMarkdown + TocSidebar), images (themed, centered, fit/100%
 * toggle), pdf (CockpitPdf, Explorer's themed viewer), json (readable widget
 * with a raw-source toggle).
 */
const FILE_VIEWER_EXT_RE = /\.(md|png|jpe?g|gif|webp|svg|pdf|json)$/i

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
  // `bash=1` is the SAME marker local files use — the /apps route has a single
  // injection rule and built-in apps get no exemption, so the entry point must
  // carry it explicitly (a nested .html it references will not).
  return (
    BUILTIN_APP_PREFIX +
    "file-viewer/index.html?bash=1&file=" +
    encodeURIComponent(abs.replace(/\\/g, "/"))
  )
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
