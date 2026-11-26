// Runs from the initial HTML stream before hydration (see BootstrapScripts).
// Five jobs:
//   1. Redirect narrow viewports to the mobile route /m (before first paint).
//   2. Apply the persisted theme class to <html> before first paint to avoid FOUC.
//   3. Install a clipboard fallback when the page is not a secure context.
//   4. Unregister any leftover Service Workers from the PWA era (PWA has been removed).
//   5. Mark the OpenCockpit desktop app's window, whose title bar is hidden.
(function () {
  // Mobile redirect — runs first and bails out the rest on redirect.
  // Signal is VIEWPORT WIDTH (not User-Agent): it's what actually decides whether the
  // desktop 3-panel layout fits. Runs synchronously in <head> before the body paints,
  // so the desktop UI never flashes. Escape hatch: the /m "use desktop" action sets
  // `cockpit-force-desktop` in localStorage, which suppresses the redirect thereafter.
  try {
    var path = window.location.pathname;
    var onMobileRoute = path === '/m' || path.indexOf('/m/') === 0;
    var forceDesktop = false;
    try { forceDesktop = !!localStorage.getItem('cockpit-force-desktop'); } catch (_e) {}
    // Never redirect inside an iframe: the desktop shell embeds /project in a
    // frame that is 42px (sidebar) narrower than the window, so a tablet-width
    // top page (e.g. 768px iPad) would otherwise nest the mobile UI inside the
    // desktop shell — and drop the sessionId in the process. The media query is
    // only meaningful for the top-level viewport.
    var isTopWindow = true;
    try { isTopWindow = window.self === window.top; } catch (_e) {}
    if (
      isTopWindow &&
      !onMobileRoute &&
      !forceDesktop &&
      window.matchMedia &&
      window.matchMedia('(max-width: 767px)').matches
    ) {
      window.location.replace('/m' + window.location.search);
      return; // stop further boot work; the page is navigating away
    }
  } catch (_e) {}

  try {
    var theme = localStorage.getItem('theme') || 'dark';
    var resolved = theme;
    if (theme === 'system') {
      resolved = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
    }
    document.documentElement.classList.add(resolved);
  } catch (e) {}

  // Desktop app (desktop/): the window has no title bar and its controls are
  // drawn over the page (titleBarStyle: 'hidden'); these classes make room for
  // them — see the .app-titlebar-* rules in globals.css. The app identifies
  // itself by a `CockpitDesktop/<version>` User-Agent suffix.
  //   - macOS: traffic lights top-left, over the sidebar of the top window.
  //   - Windows: controls top-right, over the project top bar, which lives in
  //     an iframe; the top window keeps the drag strip and reports the top
  //     bar's colours so the OS-painted overlay matches the theme.
  try {
    if (/ CockpitDesktop\//.test(navigator.userAgent)) {
      var isTop = window.self === window.top;
      var root = document.documentElement;
      if (/Mac/.test(navigator.platform)) {
        if (isTop) root.classList.add('desktop-app-mac');
      } else if (/Win/.test(navigator.platform)) {
        root.classList.add(isTop ? 'desktop-app-win' : 'desktop-app-win-frame');
        if (isTop && window.cockpitDesktop) {
          var toHex = function (rgb) {
            var m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(rgb || '');
            if (!m) return null;
            return '#' + [m[1], m[2], m[3]].map(function (n) {
              return ('0' + Number(n).toString(16)).slice(-2);
            }).join('');
          };
          var lastColors = '';
          var syncTitleBar = function () {
            if (!document.body) return;
            // The same utilities the project top bar uses (bg-card / text-foreground).
            var probe = document.createElement('div');
            probe.className = 'bg-card text-foreground';
            probe.style.cssText = 'position:fixed;width:0;height:0;visibility:hidden';
            document.body.appendChild(probe);
            var style = getComputedStyle(probe);
            var color = toHex(style.backgroundColor);
            var symbolColor = toHex(style.color);
            document.body.removeChild(probe);
            if (!color || !symbolColor || color + symbolColor === lastColors) return;
            lastColors = color + symbolColor;
            window.cockpitDesktop.setTitleBarColors(color, symbolColor);
          };
          // Theme switches toggle a class on <html>; follow them.
          new MutationObserver(syncTitleBar).observe(root, { attributes: true, attributeFilter: ['class'] });
          if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', syncTitleBar);
          else syncTitleBar();
        }
      }
    }
  } catch (_e) {}

  // Clipboard fallback for insecure contexts.
  // navigator.clipboard is only exposed on https / localhost, so every
  // writeText() call in the app throws when Cockpit is opened over the LAN at
  // http://<ip>:<port> — which is exactly how shared review links get opened.
  // Defining the shim here fixes every call site at once (there are ~50) and
  // covers future ones, instead of guarding each caller.
  // Only writeText is provided: nothing reads the clipboard, and the two image
  // copy paths (ImagePreview / MessageBubble) probe `navigator.clipboard?.write`
  // and keep their own fallback when it is absent.
  // ponytail: execCommand path only — it needs the document focused and may be
  // refused by Safari outside a user-gesture stack. Swap in a real shim only if
  // a caller ever needs clipboard read or that ceiling is actually hit.
  try {
    if (!navigator.clipboard) {
      Object.defineProperty(navigator, 'clipboard', {
        value: {
          writeText: function (text) {
            try {
              var ta = document.createElement('textarea');
              ta.value = text;
              ta.setAttribute('readonly', '');
              ta.style.cssText = 'position:fixed;top:-9999px;opacity:0';
              document.body.appendChild(ta);
              ta.select();
              ta.setSelectionRange(0, ta.value.length); // iOS ignores select()
              var ok = document.execCommand('copy');
              document.body.removeChild(ta);
              return ok
                ? Promise.resolve()
                : Promise.reject(new Error('copy command was rejected'));
            } catch (e) {
              return Promise.reject(e);
            }
          },
        },
      });
    }
  } catch (_e) {}

  // Clean up legacy Service Workers from the old PWA era, but KEEP our
  // push-only SW (/push-sw.js) — it powers Web Push notifications and does no
  // caching, so it doesn't reintroduce the offline behavior we removed.
  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.getRegistrations().then(function (regs) {
      regs.forEach(function (r) {
        var url = (r.active && r.active.scriptURL) || '';
        if (url.indexOf('/push-sw.js') === -1) r.unregister();
      });
    });
  }
})();
