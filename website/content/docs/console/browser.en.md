OpenCockpit works with two kinds of browser targets, and the AI can drive both with [`cockpit browser`](/en/docs/reference/cli/#cockpit-browser):

- **Web pages open as real Chrome tabs** — with your logins, in a **Cockpit** tab group. Nothing refuses to load and nothing is embedded.
- **Browser bubbles** in the Console show **Cockpit-served content**: local HTML apps and file previews (Markdown, JSON, CSV, images, PDF, …).

Both need the [OpenCockpit Bridge extension](/en/docs/console/chrome-extension/#install) for the AI to act on them.

## Opening a web page

Type any URL in the Console input bar:

```text
https://example.com
```

The page opens as a new Chrome tab in the **Cockpit** group and Chrome comes to the front. A toast shows the command for that tab, e.g. `cockpit browser qmmm`. Tabs Cockpit opens are allowed for the AI straight away.

If the extension isn't connected, the URL opens in a plain new browser tab instead, which the AI can't drive.

> Pages you opened as browser bubbles in an earlier version now show **Web pages now open in Chrome tabs, not in the console.** with an **Open in Chrome** button.

## Handing a tab to the AI

Navigate the page yourself to get it into the right state — log in, open the right screen — then give the AI the tab's id. Find it in:

- the toast shown when Cockpit opened the tab;
- the extension's toolbar popup (**Copy** copies `cockpit browser <id>`);
- `cockpit browser tabs`, which lists every tab with its id.

Paste it into the **Agent** panel with what you want done:

```text
The tab `cockpit browser qmmm` shows our admin dashboard.
Capture the network request when I click "Refresh metrics" and tell me
why it's taking 4 seconds.
```

The AI can now read the page, click and type with real input, capture console and network traffic, answer dialogs, upload files, take screenshots and emulate a phone — see the [CLI Reference](/en/docs/reference/cli/#cockpit-browser) for everything.

Tabs **you** opened work too, but the first command on one asks you first: the tab comes to the front and the extension's popup offers **Allow this tab** / **Deny**. Permission is per tab, and **Stop** in the popup (or `cockpit browser <id> release`) takes it back. See [Using the extension](/en/docs/console/chrome-extension/#using-it).

## Browser bubbles: local HTML and files

Running `cockpit browser open ./report.html` (or a file path) opens a browser bubble in the Console of the project that owns it. When maximised (`Cmd+M`), its header from left to right:

- **🌐 Short-ID badge** — copies `cockpit browser <id>` (or `cockpit-dev browser <id>` in dev).
- **🔄 Loading spinner** — visible while the page is loading.
- **Current URL** — editable; press Enter to navigate.
- **📋 Copy URL** — copies the current URL.
- **↻ Refresh** — reload the page.
- **↗ Open in new window** — opens the current URL in a new browser window.
- **✕ Exit maximise** — `Esc` works too.

> When not maximised, the bubble shrinks to a thumbnail with a slimmer header.

Previewing a local `.html` **runs it**, with the same access as any [HTML app](/en/docs/agent/html-apps/) — only preview files you trust.

### Bubble lifecycle

- **Multiple bubbles** — open as many as you want, and drag to reorder.
- **Sleep** — a bubble that hasn't been on screen for 5 minutes and isn't registered for the AI unloads to save memory; the status bar shows "Sleeping". Click to wake it. A `cockpit browser <id>` command wakes it automatically, as long as its project is open in a Cockpit window.
- **Load failure** — the bubble shows an error with a **Retry** button.
- **Close** — removes the bubble; opening the same file again starts fresh.

## Common issues

- **"OpenCockpit Bridge not connected"** — install or reload the [extension](/en/docs/console/chrome-extension/#install), and make sure Cockpit is running.
- **A command waits for "Waiting for the user to allow control"** — the tab is one of yours; answer in the extension's popup (the icon shows **?**).
- **Chrome shows "started debugging this browser"** — expected while the AI works on a tab; see [the debugging bar](/en/docs/console/chrome-extension/#using-it).
- **`cockpit browser open <file>` exits with code 2** — no Cockpit window has that project open; open the project (or check `--cwd`) and retry.

## Next

- [Chrome Extension](/en/docs/console/chrome-extension/#what-it-does) — how it works and what it can do
- [CLI Reference → cockpit browser](/en/docs/reference/cli/#cockpit-browser) — every command
