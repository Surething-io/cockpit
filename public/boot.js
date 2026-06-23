// Runs before React hydrates (see app/layout.tsx <Script strategy="beforeInteractive">).
// Three jobs:
//   1. Redirect narrow viewports to the mobile route /m (before first paint).
//   2. Apply the persisted theme class to <html> before first paint to avoid FOUC.
//   3. Unregister any leftover Service Workers from the PWA era (PWA has been removed).
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
    if (
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
