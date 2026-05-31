The Cockpit Chrome extension is optional. Most of Cockpit — Agent, Explorer, terminal / database / Jupyter bubbles — works fine without it. You only need it if you want the **Browser bubble** to behave like a real Chrome tab instead of a plain iframe.

If you ever fight CORS errors, login-cookie issues, or "this site refuses to be embedded" messages in a Browser bubble, the extension is the fix.

| Section | What's in it |
|---|---|
| [What it does](#what-it-does) | The four capabilities the extension unlocks for the Browser bubble |
| [Install](#install) | Three-minute setup, plus how the auto-reload across upgrades works |
| [Permissions](#permissions) | What Chrome asks for, why each permission is needed, and the privacy boundaries |

## What it does

Cockpit ships an optional Chrome extension. You don't need it for most of Cockpit — the Agent, Explorer, and database / terminal bubbles work fine without it. You only need it if you want the **Browser bubble** to behave like a real Chrome tab instead of a plain iframe.

If you ever fight CORS errors, login-cookie issues, or "this site refuses to be embedded" messages in a Browser bubble, the extension is the fix.

### What it adds

The extension does four things, all scoped to Cockpit's Browser bubbles:

#### 1. Reuses your real Chrome cookies

Without the extension, an iframe inside Cockpit doesn't share cookies with the rest of your Chrome — so if you're logged into a site in your normal browser, the Browser bubble sees it as logged out. The extension injects the right cookies before each request so the bubble appears logged in just like your main browser tabs.

#### 2. Intercepts link clicks

`target="_blank"` links would normally open a new tab in Chrome and lose the connection to Cockpit. The extension catches those clicks and routes them back into Cockpit — either updating the current Browser bubble's URL or opening a new bubble, depending on context. This keeps your AI-driven workflows intact across navigations.

#### 3. Captures full network request bodies

The `network` and `network_record` actions of [`cockpit browser`](/en/docs/reference/cli/#cockpit-browser) can return request and response bodies — but only if the extension is installed. Without it, you get URL and status info, no bodies.

#### 4. Enables in-page JavaScript execution

The `evaluate` action runs JavaScript in the page context. Without the extension this is restricted by iframe sandboxing; with it, you can run anything you'd run in a Chrome DevTools console.

### Without the extension

You can still:

- Load any page that doesn't refuse iframes (most public sites, `localhost`).
- Click around, scroll, see what's there.
- Take screenshots (limited resolution).
- Get URL, title, and minimal element info.

You can't:

- Stay logged in to sites you use in your normal Chrome.
- Keep links working when they'd open new tabs.
- See request / response bodies in network captures.
- Run arbitrary JavaScript with full page access.

### Privacy

The extension only activates on tabs Cockpit has explicitly told it about (it tracks them with a hidden `_cockpit=1` URL parameter). It doesn't read or interfere with any other browsing you do in Chrome.

See [Permissions](#permissions) for the exact list of permissions the extension requests and why.

## Install

Installing the Cockpit Chrome extension takes about three minutes. The extension files were already copied to your Cockpit data folder when you installed Cockpit — you just need to tell Chrome about them.

### Step by step

#### 1. Get the extension path

In Cockpit, open **Settings**. Find the **Chrome Extension** section. Click **Copy extension path**.

That puts something like `~/.cockpit/chrome-extension/` (the full absolute path) on your clipboard.

#### 2. Open Chrome's extensions page

In Chrome, go to `chrome://extensions`.

#### 3. Enable Developer mode

Top-right corner of the extensions page, there's a **Developer mode** toggle. Turn it on. This is required to load unpacked extensions; it doesn't affect anything else.

#### 4. Load unpacked

Three buttons appear when Developer mode is on: **Load unpacked**, **Pack extension**, **Update**. Click **Load unpacked**.

A file picker opens. Paste the path you copied in step 1, hit Open / Select.

That's it. The extension card appears in your extensions list. **The card title says "OpenCockpit Bridge"** (that's the `name` field in `manifest.json`) and shows the version number.

### Verify

Switch back to Cockpit, refresh the page. In **Settings → Chrome Extension**, the indicator turns **green** with the extension version number next to it.

If you open a Browser bubble after this, the URL bar gets a small marker showing the bubble is now extension-powered.

### Updating and reloading

When you `cockpit update` to a new Cockpit version, the extension files in `~/.cockpit/chrome-extension/` get refreshed. **Chrome does not automatically pick up those file changes** — Chrome extensions have no native file-watching reload. To activate the new version:

1. Open Cockpit's **Settings → Chrome Extension**. Once the extension is installed, a **Reload extension** button appears there — click it.
2. Or go to `chrome://extensions` and click the refresh icon on the **OpenCockpit Bridge** card.

You don't need to reinstall in Chrome — just reload. Refresh any open Browser bubble afterwards to pick up the new code.

### Removing the extension

To remove:

1. In Chrome go to `chrome://extensions`.
2. Find the Cockpit card.
3. Click **Remove**.

Cockpit's Settings indicator will go back to grey on next page load.

### Common issues

- **"Failed to load" in Chrome** — the path you pasted doesn't point to a folder. Re-copy from Settings, paste exactly.
- **Extension loads but Cockpit settings still says "not installed"** — refresh the Cockpit page in your browser.
- **Indicator stays grey after refresh** — the extension is on a different Chrome profile than the one Cockpit is open in. Switch profiles or install the extension into both.

## Permissions

When you load the Cockpit Chrome extension, Chrome shows a permissions list. This page explains what each permission is for, so you can decide whether you're comfortable with it.

### The permissions

| Permission | Why Cockpit needs it |
|---|---|
| **`storage`** | Save the extension's own settings (which Cockpit instance to talk to, etc.) — small, local, doesn't touch your browsing data. |
| **`cookies`** | Read the cookies for sites you visit in Cockpit's Browser bubble, so it can inject them when the iframe requests the same site. This is what "stay logged in" looks like under the hood. |
| **`declarativeNetRequest`** | Inject the cookies above into outgoing requests via Chrome's network rules layer. Each rule is scoped to a specific Cockpit tab — never to the rest of your browser. |
| **`webNavigation`** | Track when a Cockpit-marked iframe navigates so the extension knows which bubble corresponds to which Chrome frame. |
| **`tabs`** | Identify which Chrome tab is the Cockpit tab so the extension can scope its work to it. |
| **`scripting`** | Inject the small content-script that handles link interception and JavaScript evaluation inside Browser bubbles. |
| **`webRequest`** | Watch the final headers Chrome sends, used for debugging the cookie injection above. Read-only — doesn't modify requests. |
| **`host_permissions: <all_urls>`** | The extension needs to be able to operate on whatever URL you load in a Browser bubble. Since you can load any URL, the extension has to be allowed on all of them. |
| **`externally_connectable: localhost / 127.0.0.1`** | Allow the Cockpit web app running on `http://localhost:*` or `http://127.0.0.1:*` to message the extension directly — for fast, ordered cookie injection that survives page navigation. |
| **`web_accessible_resources`** | Exposes `disguise.js`, `automation.js`, and `network-capture.js` so the Cockpit page can inject them into Browser bubbles — these are the scripts that disguise the frame as a real tab, run automation actions, and capture network traffic. |
| **`declarative_net_request` rule_resources** | A bundled DNR ruleset; one rule strips the `_cockpit=1` marker from request URLs before they leave Chrome, so external servers never see it. |

### Privacy boundaries

The extension is built to do its work **only on tabs Cockpit is using**. The mechanism: Cockpit adds a hidden `_cockpit=1` parameter to every URL it loads in a Browser bubble. The extension only enables its features on tabs / iframes whose top-level URL matches.

So while the permissions say "all URLs" (which is required for it to be technically able to run on whatever site you ask Cockpit to load), it's gated by the `_cockpit=1` marker:

- Your normal Chrome browsing tabs → extension does nothing.
- Other extensions' iframes → extension does nothing.
- Cockpit-marked iframes → extension enables cookie injection, link interception, evaluate JS.

### What the extension doesn't do

To be specific about what it does NOT do, even with the broad permissions:

- It does not read or send any browsing data to any server.
- It does not modify pages you visit outside Cockpit.
- It does not inject cookies into requests outside the Cockpit-marked frames.
- It does not log keystrokes, mouse movements, or anything else passively.
- It does not phone home — no telemetry, no analytics, no auto-update server (it updates only via your `cockpit update`).

The full extension source code is in the Cockpit npm package under `chrome-extension/` — if you're security-conscious, you can read it yourself.

### Trust model

The reason the extension is shipped *as code you load yourself* (rather than published on the Chrome Web Store) is precisely so you can audit it. You're trusting Cockpit-the-tool, not a third-party publisher. Every install is whatever your `~/.cockpit/chrome-extension/` folder contains.
