/**
 * htmlBashSdk — the `window.cockpit` bash SDK injected into previewed HTML.
 *
 * Two injection sites share this single source of truth:
 *   - HtmlPreview (client, srcDoc iframe): explorer file preview + chat preview.
 *     A srcDoc document's URL is `about:srcdoc` (no origin), so the host MUST
 *     bake an absolute `wsUrl`.
 *   - /api/preview (server, real-URL iframe): the console browser bubble loads
 *     local HTML over `http://host/api/preview/...`. There the page has a real
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
 * floating top-right toggle flips light/dark, remembered per app across
 * reloads (key namespaced by cockpit-name / page path; localStorage is
 * shared); a stored user choice wins over the host. window.cockpit.toggleTheme() too.
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
      var mountThemeBtn = function () {
        if (themeBtn || !document.body) return;
        themeBtn = document.createElement('button');
        themeBtn.type = 'button';
        themeBtn.setAttribute('aria-label', 'Toggle theme');
        themeBtn.textContent = document.documentElement.classList.contains('dark') ? '☀️' : '\u{1F319}';
        themeBtn.style.cssText = 'position:fixed;top:10px;right:10px;z-index:2147483647;width:30px;height:30px;' +
          'border-radius:8px;border:1px solid rgba(128,128,128,.3);background:rgba(128,128,128,.14);' +
          'color:inherit;cursor:pointer;font-size:14px;line-height:1;display:flex;align-items:center;' +
          'justify-content:center;padding:0';
        themeBtn.onclick = toggleTheme;
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
  var queue = [];
  var handlers = {};
  var seq = 0;

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

  function ensureWs() {
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;
    try { ws = new WebSocket(resolveWsUrl()); }
    catch (e) { failAll(String(e)); return; }
    ready = false;
    ws.onopen = function () {
      ready = true;
      var q = queue; queue = [];
      for (var i = 0; i < q.length; i++) ws.send(q[i]);
    };
    ws.onmessage = function (ev) {
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
    ws.onclose = function () { ready = false; failAll('connection closed'); };
    ws.onerror = function () { /* onclose follows */ };
  }

  function send(obj) {
    var s = JSON.stringify(obj);
    ensureWs();
    if (ready && ws && ws.readyState === 1) ws.send(s);
    else queue.push(s);
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
  window.cockpit = { cwd: CWD, bash: bash, toggleTheme: function () { toggleTheme(); } };
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
//   - /api/preview (server): passes its already-normalized absolute fullPath;
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

/**
 * Map a local file path to the `/api/preview/<encoded-abs-path>` URL served by
 * the local server (static-site style: relative siblings, images, and CDN refs
 * all resolve). Relative `filePath` is resolved against `projectRoot`. Single
 * source of truth for both the console browser bubble and the HTML preview.
 */
export function toPreviewUrl(filePath: string, projectRoot?: string): string {
  const trimmed = filePath.trim()
  const abs = isAbsolutePath(trimmed)
    ? trimmed
    : joinPath(projectRoot ?? "", trimmed)
  // Normalize Windows separators to `/` so the URL is properly segmented. A
  // Windows absolute path (C:\Users\x) has no `/` — without this the whole path
  // becomes one blob-encoded segment and loses the `/api/preview/` separator.
  // Always emit exactly one slash between the prefix and the (possibly
  // drive-lettered) path, so both `/Users/x` and `C:/Users/x` are well-formed.
  const encoded = abs
    .replace(/\\/g, "/")
    .split("/")
    .map(encodeURIComponent)
    .join("/")
    .replace(/^\//, "")
  // `?bash=1` → /api/preview injects the window.cockpit bash SDK. Every
  // toPreviewUrl caller is a deliberate user gesture (explorer preview button,
  // console-typed path / `/name` app), so the flag is unconditional here. The
  // server-side gate still matters: relative sub-resources loaded FROM a
  // previewed page (./app.jsx, nested html, file-viewer fetches) hit
  // /api/preview without the query and are served raw — SDK injection stays
  // scoped to top-level, user-opened documents. The hard enforcement is the
  // /ws/bash same-origin gate either way.
  return "/api/preview/" + encoded + "?bash=1"
}

/**
 * Extensions handled by the built-in file-viewer app (public/apps/
 * file-viewer.html): markdown (CockpitMarkdown + TocSidebar), images (themed,
 * centered, fit/100% toggle), pdf (CockpitPdf, Explorer's themed viewer),
 * json (pretty-printed + highlighted via the markdown widget).
 */
const FILE_VIEWER_EXT_RE = /\.(md|png|jpe?g|gif|webp|svg|pdf|json)$/i

/** True for a local file path the console routes to the file-viewer app. */
export function isFileViewerPath(filePath: string): boolean {
  return FILE_VIEWER_EXT_RE.test(filePath.trim())
}

/**
 * Map a local file path to the built-in file-viewer html app
 * (`/apps/file-viewer.html?file=<abs>`, served from public/apps/). Same
 * relative path resolution as toPreviewUrl; the viewer fetches the raw content
 * itself via /api/preview and (for markdown) resolves relative images against
 * the file's directory.
 */
export function toFileViewerUrl(filePath: string, projectRoot?: string): string {
  const trimmed = filePath.trim()
  const abs = isAbsolutePath(trimmed)
    ? trimmed
    : joinPath(projectRoot ?? "", trimmed)
  return "/apps/file-viewer.html?file=" + encodeURIComponent(abs.replace(/\\/g, "/"))
}

/**
 * Reverse of toPreviewUrl: `/api/preview/<encoded-abs>` → the absolute file path
 * (with `/` separators; node `path` on the server accepts `/` on Windows too).
 * Returns null on a path-traversal attempt or a NUL byte. The caller still runs
 * path.normalize + a filesystem stat.
 */
export function fromPreviewUrl(pathname: string): string | null {
  const PREFIX = "/api/preview/"
  const rest = pathname.startsWith(PREFIX)
    ? pathname.slice(PREFIX.length)
    : pathname.replace(/^\/+/, "")
  // toPreviewUrl encodes per-segment, so a single decode restores the path.
  let raw = "/" + decodeURIComponent(rest)
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
