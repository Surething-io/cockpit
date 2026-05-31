The Browser bubble drives a real Chrome tab from inside Cockpit's Console panel. You point it at a URL, the page loads, and from there you can navigate, click, type, take screenshots, capture network traffic, and (importantly) **hand the whole tab off to the AI to drive on your behalf**.

Open one by typing any URL in the Console input bar:

```text
https://example.com
```

## Header controls (when maximised)

The bubble shows the live page in an embedded view. When maximised (`Cmd+M`), the header from left to right:

- **🌐 Short-ID badge** — clicking registers the bubble for CLI control and copies `cock browser <id>` (or `cockpit-dev browser <id>` in dev) to your clipboard. Paste into the Agent panel and the AI can now drive this exact tab.
- **🔄 Loading spinner** — visible while the page is loading.
- **Current URL** — editable; press Enter to navigate.
- **📋 Copy URL** — copies the current URL to your clipboard.
- **↻ Refresh** — reload the current page.
- **↗ Open in new window** — opens the current URL in your system browser.
- **✕ Exit maximise** — `Esc` works too.

> When not maximised, the bubble shrinks to a thumbnail (`scale(0.5)`) with a slimmer header.

## With and without the Chrome extension

The Browser bubble works **without** the Cockpit Chrome extension — it just shows the page in an iframe. That's enough for `localhost` sites and most public pages.

With the **[Cockpit Chrome extension](/en/docs/console/chrome-extension/#what-it-does)** installed:

- Re-uses your real Chrome cookies (the extension pre-injects them via `chrome.runtime.sendMessage` before the iframe loads, with a 2-second timeout).
- Intercepts link clicks inside the iframe (`cockpit:new-tab` / `cockpit:navigate` postMessages) so "open in new tab" plays nicely with Cockpit instead of opening a separate window.
- Captures network requests with full request and response bodies.

If you find yourself fighting CORS, login redirects, or "can't load in iframe" errors, installing the extension usually solves it. There's no explicit "extension connected" badge — its state is implicit via the internal bridge connection (which affects the sleep behaviour below).

## Handing the tab to the AI

This is the killer feature. Navigate the page yourself to get it into the right state — log in, click the right tab, fill some context — then:

1. Click the short-ID badge in the header. It copies `cock browser <id>` to your clipboard.
2. Switch to the **Agent** panel and paste into chat with whatever you want the AI to do, e.g.:

```text
The bubble at `cock browser xa7k2` shows our admin dashboard.
Capture the network request when I click "Refresh metrics" and tell me
why it's taking 4 seconds.
```

The AI can now run `cock browser xa7k2 …` commands to inspect and drive the page — read the DOM, capture network traffic, execute JavaScript, take screenshots, click and type.

See the [CLI Reference for `cockpit browser`](/en/docs/reference/cli/#cockpit-browser) for the full action list.

## Bubble lifecycle

- **Multiple bubbles** — open as many browser bubbles as you want, each on its own URL.
- **Drag to reorder** — same as every other bubble.
- **Sleep** — if a browser bubble hasn't been visible in the viewport for 5 minutes (tracked via `IntersectionObserver`) **and** isn't currently being driven by the AI bridge, Cockpit unloads its iframe to save memory; the status bar shows a yellow "sleeping" marker. Click "Wake" to reload the page — the URL is preserved.
- **Load failure** — if the iframe fails to load, the bubble shows an error message with a **Retry** button.
- **Close** — removes the bubble from the panel; opening the same URL again starts a fresh page load.

## Common issues

- **Page won't load / shows blank** — most often a site that refuses to be iframed (CSP `frame-ancestors` or `X-Frame-Options`). Install the [Chrome extension](/en/docs/console/chrome-extension/#install) and it usually works.
- **Login expired** — without the extension, the iframe doesn't share cookies with your normal Chrome. Either log in inside the iframe or install the extension.
- **AI can't drive the bubble** — make sure you clicked the short-ID badge first; the bubble has to be registered for `cock browser <id>` to find it.

## Next

- [Chrome Extension](/en/docs/console/chrome-extension/#what-it-does) — what it adds
- [CLI Reference → cockpit browser](/en/docs/reference/cli/#cockpit-browser) — what the AI can do with `cock browser <id>`
