The OpenCockpit desktop app for macOS and Windows gives Cockpit its own window and Dock / Start-menu entry. It is a window onto the Cockpit on your machine, not a second server: it uses your npm install, starts it when needed, and leaves it running when you close the window.

## Install

You need Cockpit itself first ([Node.js 22.19.0 or later](https://nodejs.org/en/download), then `npm i -g @surething/cockpit`). Then:

```bash
cockpit app install
```

This downloads the app built for your exact Cockpit version from GitHub Releases, verifies it against the SHA-256 shipped inside the npm package, and installs it to:

| OS | Location |
|---|---|
| macOS | `~/Applications/OpenCockpit.app` |
| Windows | `%LOCALAPPDATA%\Programs\OpenCockpit`, plus a Start-menu entry |

Open it like any other app. Linux has no desktop app; install the page as a [web app (PWA)](/en/docs/get-started/quickstart/#or-install-it-as-a-web-app-pwa) instead.

### Downloading by hand

The `.dmg` (macOS) and `.zip` (Windows) files are also attached to every [GitHub Release](https://github.com/Surething-io/cockpit/releases), with checksums in `SHA256SUMS`. The builds are **not code-signed**, so a file downloaded through a browser is stopped once:

- **macOS**: open the app, dismiss the warning, then go to **System Settings → Privacy & Security** and click **Open Anyway**. Or run `xattr -dr com.apple.quarantine /Applications/OpenCockpit.app`.
- **Windows**: unzip it anywhere and run `OpenCockpit.exe`. In the SmartScreen dialog, click **More info → Run anyway**.

`cockpit app install` avoids this: files written by Node carry no "downloaded from the internet" mark, and the checksum check stands in for the signature.

### Building it yourself

From a source checkout:

```bash
npm run desktop:build                    # output in desktop/dist/
cockpit app install --from desktop/dist  # install that build
```

`npm run install:local` builds and installs both Cockpit and the app from the checkout in one go.

## What happens when you open it

1. The app reads your login shell's environment (macOS) or the registry's `PATH` (Windows), so it finds `node`, `npm` and `cockpit` the way your terminal does. Agents and terminals started by Cockpit inherit the same environment.
2. If `cockpit` is missing, it offers to run `npm install -g @surething/cockpit`. If Node is missing or older than 22.19, it links to the Node.js download page.
3. If no server is running for your data directory (`~/.cockpit`, or `COCKPIT_HOME`), it runs `cockpit start` — the same background server you'd get from a terminal.
4. It loads `http://localhost:<port>` in its window.

Browser tabs on the same server keep working alongside the app. The app only talks to the Cockpit on this machine; for a Cockpit on a remote server, use a browser (see [Server Deployment](/en/docs/get-started/server-deployment/)).

## Closing and quitting

Closing the window or quitting the app leaves the server running in the background, like `cockpit start`. Stop it from the app's **Server** menu (**Stop…**) or with `cockpit stop`. Stopping also ends running terminals and agents.

The **Server** menu also has **Restart**, **Open in Browser** and **Open Logs Folder**.

## Look and feel

The window uses the native title bar. Its light or dark look follows Cockpit's own **Settings → Theme** (System / Light / Dark), not just the OS setting.

## Updates

Updating Cockpit (`cockpit update`, or the version pill in the sidebar) does not require a new app. The app is a thin shell that rarely changes: each Cockpit release records which build of the shell it carries, and the app only offers an update when that differs from its own.

When it does:

1. You get a notification, and the app menu shows **Download Update (version)…** (**Help** menu on Windows).
2. Downloading happens in the background while you keep working.
3. Choose **Restart to Update**, or just quit the app — the new version is swapped in on quit.

Nothing downloads without asking. Tick **Download Updates Automatically** in the same menu to skip the prompt. `cockpit app update` does the same by hand.

## Uninstall

```bash
cockpit app uninstall
```

This removes the app (and its Start-menu entry on Windows). Your projects, sessions and settings in `~/.cockpit` are untouched, and Cockpit itself stays installed.

## Troubleshooting

**"OpenCockpit is not installed yet" although `cockpit` works in my terminal**

The app looks for `cockpit` on your login shell's `PATH`. If your shell setup prints errors or takes more than ten seconds to start, the app falls back to a minimal `PATH`. Check that `$SHELL -ilc 'command -v cockpit'` prints a path.

**The server did not start**

The app shows the last lines of `cockpit start`. Click **Open logs folder** for `server.log`, or run `cockpit start` in a terminal to see the full error.

**`cockpit app install` says the install carries no desktop app checksums**

You are running Cockpit from a source checkout or a version older than 1.1.6. Update Cockpit, or build the app yourself and install it with `--from`.

**macOS says the app "is damaged and can't be opened"**

The download was blocked by Gatekeeper. Remove the quarantine mark as shown under [Downloading by hand](#downloading-by-hand), or reinstall with `cockpit app install`.
