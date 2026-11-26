Common problems people hit with OpenCockpit and how to fix them. Organised by symptom.

## Cockpit won't start

**`Error: listen EADDRINUSE: address already in use :::3457`**

Another process is using port 3457. Either:

- Stop the other process, or
- Start Cockpit on a different port:

```bash
cockpit --port 4000
```

**`Error: command not found: cockpit`**

The npm global bin directory isn't on your `PATH`. Find where npm puts global bins (`npm bin -g` was **removed** in npm 7+; use this instead):

```bash
npm config get prefix
```

It prints something like `/usr/local`; the global bin lives in `/usr/local/bin` (homebrew, nvm, etc. will differ). Add that directory to your `PATH` in your shell's profile (`~/.zshrc`, `~/.bashrc`, etc.).

**`Error: Node version is too old`**

Cockpit needs Node.js 22.19.0 or later. Check with `node -v`. Upgrade Node, then reinstall Cockpit.

## Remote access and phone QR codes

**The top bar has no QR icon**

Open the desktop workspace at a domain or private-network address your phone can reach. The icon is hidden on `localhost` and other loopback addresses. If your version predates the QR code, open the server's `/m` URL directly on your phone.

**How do I switch back after opening Desktop on my phone?**

In a narrow desktop view, click **Mobile** in the bottom-right corner, or open the server's `/m` URL directly.

**The server returns `401` or `429`**

A `401` means credentials are missing or invalid. Sign in again with your current token. After five consecutive incorrect tokens from one IP, Cockpit returns `429`. Wait for the time specified by `Retry-After` before retrying. If several visitors behind a reverse proxy get blocked together, check that the proxy forwards each visitor's IP. [Server Deployment](/en/docs/reference/server-deployment/) · [Trusted proxies](/en/docs/reference/cli/#shared-token-access-gate)

## Claude isn't working

**"Not logged in" right after sending the first message**

Cockpit doesn't manage Claude's login — it uses the `claude` CLI's own login. Run `claude` once in a terminal and complete the login flow, then try again in Cockpit.

**It worked yesterday, today it says I'm not logged in**

Your Claude session token expired. Run `claude` again to refresh it.

## A bubble isn't behaving

**A web page I opened shows up in a Chrome tab, not in the Console**

That's by design: web pages open as real Chrome tabs (in the **Cockpit** tab group), so they have your logins and no site refuses to load. Browser bubbles are only for local HTML apps and file previews. See [Browser](/en/docs/console/browser/).

**The AI can't drive a tab**

- *"OpenCockpit Bridge not connected"* — install or reload the [Chrome extension](/en/docs/console/chrome-extension/#install).
- *"Waiting for the user to allow control"* — it's one of your own tabs; answer in the extension's popup (its icon shows **?**).
- *Commands hang or mention site access* — set the extension's **Site access** to **On all sites**.

**Database bubble fails to connect**

Check the connection string format (see the per-database pages: [PostgreSQL](/en/docs/console/databases/#postgresql) / [MySQL](/en/docs/console/databases/#mysql) / [Redis](/en/docs/console/databases/#redis) / [Neo4j](/en/docs/console/databases/#neo4j)). URL-encode any special characters in passwords (`@` → `%40`, `:` → `%3A`, etc.).

**Ollama bubble can't find any models**

You haven't pulled any yet. In a terminal:

```bash
ollama pull llama3.1
```

Then create the Ollama tab again — the model picker should now list it.

## Files & code

**`Cmd+P` doesn't work**

Make sure Cockpit's window is focused (not your editor). If you're in a Notes modal or Settings, `Cmd+P` is hijacked elsewhere; close the modal first.

**Saving a file (`Cmd+S`) does nothing**

The Code Viewer opens read-only by default. Click the **Edit** button in the toolbar to switch to edit mode, then `Cmd+S` will work — clicking the content area itself doesn't toggle the mode; you need the button.

**Blame view doesn't have data for some files**

The file is too new (hasn't been committed) or you're not in a Git repo.

## Settings & data

**Where are my API keys stored?**

On your machine, protected by OS file permissions — same model as SSH keys or `~/.aws/credentials`. Everything runs locally.

**I broke my settings, how do I reset to defaults?**

Quit Cockpit, then:

```bash
rm -rf ~/.cockpit
```

Next launch will recreate the folder with defaults. You'll need to re-enter API keys.

**How do I move everything to a new machine?**

Copy the `~/.cockpit` folder from the old machine to the new one (USB, scp, rsync — your choice), install Cockpit on the new machine, and your sessions / favourites / scheduled tasks / API keys come along.

## Updating

**`cockpit update` fails with `EACCES`**

Your global npm install needs root permissions. Either:

```bash
sudo npm install -g @surething/cockpit@latest
```

Or fix npm permissions once so you don't need sudo (search "npm EACCES fix").

**I want to roll back to a previous version**

```bash
npm install -g @surething/cockpit@<old-version>
```

Find versions at [npmjs.com/package/@surething/cockpit](https://www.npmjs.com/package/@surething/cockpit).

## Performance

**Cockpit feels sluggish on a huge repo**

The first few seconds after opening a large project (10k+ files) are slow — Cockpit is indexing for Code Map and CodeGraph. Subsequent operations are fast. If it stays slow, file an issue with details about the repo size.

**Browser bubbles eat memory**

Each Browser bubble (a local HTML app or file preview) is an **iframe** inside Cockpit's page. Ten bubbles is the overhead of ten iframes in one Cockpit page. Close bubbles you're not actively using; the [sleep mechanism](/en/docs/console/browser/#bubble-lifecycle) also auto-unloads iframes after 5 minutes off-screen and reloads them on wake.

## I have a question that isn't here

- **GitHub issue tracker**: [github.com/Surething-io/cockpit/issues](https://github.com/Surething-io/cockpit/issues)
- **For specific feature questions**: check the relevant page in this docs site first — there's a sidebar on the left covering every feature.

## Next

- [Quickstart](/en/docs/get-started/quickstart/) — install, upgrade, uninstall
