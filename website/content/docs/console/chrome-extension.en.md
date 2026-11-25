The OpenCockpit Bridge extension lets [`cockpit browser`](/en/docs/reference/cli/#cockpit-browser) — and the AI in your chats — drive your real Chrome: the tabs you choose, with your own logins, plus the local HTML apps and file previews shown in Console bubbles.

It is optional. The Agent, Explorer, terminals and database bubbles work without it; you need it only when something should act inside a browser page.

| Section | What's in it |
|---|---|
| [What it does](#what-it-does) | How commands reach the browser, and what the AI can do in a tab |
| [Install](#install) | Three-minute setup, the two Chrome settings to check, and updating |
| [Using it](#using-it) | Per-tab permission, the toolbar popup, the debugging bar |
| [Permissions](#permissions) | What Chrome asks for, why, and the trust model |

## What it does

### How commands get to Chrome

```text
cockpit browser … ──▶ Cockpit server ──▶ native host ──▶ extension ──▶ your tab
                      (per-boot token)   (bin/bridge-host.mjs)
```

- Cockpit registers a small **native messaging host** with every Chromium browser it finds (Chrome, Edge, Brave, Vivaldi, Arc, Opera, Chromium) on macOS, Linux and Windows, each time it starts. You don't install anything else.
- The host connects to every running Cockpit instance (prod and dev alike) using a token that changes on every server start.
- The extension takes commands **only** from that host. No web page — Cockpit's own UI included — can send it a command. It does not rewrite headers, inject cookies or disguise pages; sites run exactly as they would without it.

### What the AI can do in a tab

Everything a person at the keyboard can:

- **Read the page** — an accessibility-tree snapshot that includes cross-origin iframes and shadow DOM, plus `evaluate` for JavaScript.
- **Act with real input** — clicks, typing, keys, hover, scrolling, drag-and-drop and long presses go through Chrome's own input pipeline, so pages see trusted events.
- **Handle what usually blocks automation** — `alert` / `confirm` / `prompt` dialogs and file uploads (no OS file picker appears).
- **Inspect** — console messages, network requests with bodies, event listeners, performance metrics, CSS coverage, and full-page or single-element screenshots.
- **Test conditions** — phone / tablet viewports with touch, dark theme, offline or slow networks, CPU throttling, blocked URLs and print media.

Web pages always open as **real Chrome tabs** (grouped under **Cockpit**), so they have your logins and nothing refuses to load. Console bubbles are only for Cockpit-served content: local HTML apps and file previews.

## Install

The extension files are copied to `~/.cockpit/chrome-extension/` when you install or update Cockpit. Chrome just needs to be pointed at them once.

### Step by step

#### 1. Copy the path

In Cockpit, open **Settings → Browser Extension** and click **Copy extension directory path**.

#### 2. Open Chrome's extensions page

Go to `chrome://extensions` (or the same page in Edge, Brave, …).

#### 3. Turn on Developer mode

Top-right toggle. It is needed to load an extension from a folder and changes nothing else.

#### 4. Load unpacked

Click **Load unpacked** and pick the folder you copied in step 1. The card **OpenCockpit Bridge** appears.

#### 5. Check two settings on the card

Click **Details** on the card:

- **Site access** must be **On all sites**. Which tabs Cockpit may act on is still decided by you, tab by tab (see [Using it](#using-it)); without site access Chrome silently blocks the extension from running in pages. If it is withheld, the toolbar popup shows a **Grant access to all sites** button.
- **Allow access to file URLs** — turn it on if the AI should be able to **upload files** into web pages. Everything else works without it.

### Verify

In **Settings → Browser Extension** the indicator shows **OpenCockpit Bridge connected**. You can also run:

```bash
cockpit browser tabs
```

which lists your open tabs with their ids.

### Updating

`cockpit update` refreshes the files in `~/.cockpit/chrome-extension/`, but **Chrome keeps running the old code until the extension is reloaded**:

- **Settings → Browser Extension → Reload extension**, or
- the reload icon on the **OpenCockpit Bridge** card in `chrome://extensions`.

### Removing

`chrome://extensions` → **OpenCockpit Bridge** → **Remove**.

### Common issues

- **"OpenCockpit Bridge not connected"** — Cockpit must be running (it registers the native host on start). If you installed a new Chromium browser after starting Cockpit, restart Cockpit once.
- **Commands hang or fail with a site-access message** — set **Site access** to **On all sites** (step 5).
- **Upload fails with "Allow access to file URLs"** — turn that switch on (step 5).
- **Behaviour didn't change after updating** — reload the extension (see [Updating](#updating)).

## Using it

### Every tab has an id

Every tab gets a short, stable id such as `qmmm`. Find it in the toolbar popup (with a **Copy** button that copies `cockpit browser qmmm`), in the icon's tooltip, or with `cockpit browser tabs`. Give it to the AI and it can work on that tab.

### Permission is per tab

- Tabs **Cockpit opens** (e.g. a URL typed into the Console input bar, or `cockpit browser open <url>`) are allowed automatically.
- **Any other tab** — one of yours — is not. The first command on it brings that tab to the front and asks in the toolbar popup: **Allow this tab** or **Deny**. Allowing one tab never allows another tab, even on the same site.
- **Stop** in the popup, or `cockpit browser <id> release`, takes the permission back; the next command asks again.
- `close` only closes tabs Cockpit opened, never yours.

### The toolbar icon

| Icon | Meaning |
|---|---|
| Grey | Cockpit will ask before acting on this tab |
| Green dot | Cockpit may act on this tab |
| Orange dot | Cockpit is driving this tab right now |
| **?** badge | Cockpit is asking for permission — click the icon to answer |

### The popup

Click the icon to see:

- **Cockpit is driving now** — tabs the debugger is attached to and why (e.g. *console & network capture, 2 min left · iPhone 15 viewport*). Click a row to switch to that tab; **Stop** lets go immediately and undoes any emulation.
- **This tab** — its id, **Copy**, and **Allow** / **Stop**.
- **Other tabs Cockpit may control** — click to switch, **Stop** to revoke.

### "OpenCockpit Bridge started debugging this browser"

Chrome shows this bar on **every** tab whenever the extension's debugger is attached to **any** tab. The extension cannot change its text or limit it to one tab — use the popup or the orange icon to see which tab it is.

The debugger lets go a few seconds after the last command, except while something needs it to stay:

- console / network capture — ends 2 minutes after the AI last reads it;
- a viewport, theme or `emulate` setting — until it is reset;
- an open dialog waiting for an answer.

**Stop** in the popup or **Cancel** on the bar ends it at once, and the page gets its normal size back.

## Permissions

| Permission | Why |
|---|---|
| **`nativeMessaging`** | The only way commands arrive: from the native host Cockpit registered. |
| **`debugger`** | Real input, dialogs, uploads, screenshots, emulation and console / network capture (Chrome DevTools Protocol). Attached only while working, which is when Chrome shows its debugging bar. |
| **`scripting`** | Run the page-reading code (snapshot, element lookup) in the tab or bubble being driven. |
| **`tabs`**, **`tabGroups`** | List tabs with their ids, open / show / close the tabs Cockpit opens, and keep them in the **Cockpit** group. |
| **`webNavigation`** | Find the frames inside a page (iframes, Console bubbles). |
| **`storage`** | Remember tab ids and which tabs you allowed, across browser restarts. |
| **`alarms`** | Reconnect to the native host if it restarts. |
| **`clipboardWrite`** | The **Copy** button in the popup. |
| **`host_permissions: <all_urls>`** | Chrome requires it to run in whatever page you allow. Which tabs Cockpit actually touches is your per-tab choice. |

A content script also runs in every frame but stays inert unless the frame is a Cockpit Console bubble (named `cockpit-bubble-…`, inside a local Cockpit page, same origin as it); there it records console and network activity for `cockpit browser`.

### What it doesn't do

- It doesn't accept commands from web pages — only from the native host, which only relays from Cockpit servers holding the current token.
- It doesn't act on a tab you haven't allowed (or that Cockpit didn't open).
- It doesn't rewrite requests or responses, inject cookies, or read your cookies.
- It doesn't send browsing data anywhere — no telemetry, no update server; it updates only with Cockpit.

### Trust model

The extension is shipped as code you load yourself, so you can read it: it's the `chrome-extension/` folder of the Cockpit package, and the trust model is spelled out at the top of `chrome-extension/background.js`.

One consequence worth stating plainly: once you allow a tab, the AI acts in it **with your login**. Allow tabs the way you'd hand someone your keyboard — and **Stop** them when the work is done.
