// Runs before React hydrates (see app/layout.tsx <Script strategy="beforeInteractive">).
// Four jobs:
//   1. Redirect narrow viewports to the mobile route /m (before first paint).
//   2. Apply the persisted theme class to <html> before first paint to avoid FOUC.
//   3. Install a clipboard fallback when the page is not a secure context.
//   4. Unregister any leftover Service Workers from the PWA era (PWA has been removed).
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
