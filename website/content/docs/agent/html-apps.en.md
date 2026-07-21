A plain HTML preview is **static** — try to pull real data from the page and the same-origin sandbox blocks it via CORS. **HTML apps** tear that wall down: `/html` has the AI generate a small app, and the preview injects a `window.cockpit` SDK — **essentially the Bash tool exposed to the page**. Now a button can `curl` for data, read/write files, or run a script. A static page becomes a mini-app with a backend.

It's a built-in command in the [Skills](/en/docs/agent/skills/) `/` menu, resolving the same way as `/qa` or `/fx`. The generated page runs in the **chat preview modal**, the **Explorer file browser**, or a [Console browser bubble](/en/docs/console/browser/) — and you can bookmark it into an **HTML panel** to reopen anytime.

## Generate one with `/html`

Type `/html` in the Agent chat box, followed by the page you want:

```text
/html Build me a GitHub repo star dashboard — type a repo name, show stars, forks, and recent commits
```

The rest is the AI's job — you just describe **what you want**, not how to build it. By default it will:

- generate a **React page** (zero-build; the dependencies are hosted locally by Cockpit, so it works offline);
- **apply the Cockpit theme automatically**, with light/dark and a top-right toggle;
- fetch/update data through `cockpit.bash` (**not** `fetch(externalURL)` — CORS blocks it).

> These rules live in the built-in `/html` prompt; you normally don't need to think about them. When you want to hand-edit a page, see the SDK cheatsheet below.

## `cockpit` SDK cheatsheet

The global is ready on page load — **no library to import**:

| API | What it does |
|---|---|
| `cockpit.cwd` | Directory of the current file; relative-path commands run here |
| `cockpit.bash(command, opts?)` | Run one bash command, mirroring the Bash tool |
| `cockpit.toggleTheme()` | Switch light/dark (there's a top-right button too) |

`cockpit.bash` returns the full output in the foreground, or streams in the background:

```js
// Foreground: short command, await for { stdout, stderr, exitCode }
const { stdout, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
if (exitCode !== 0) { /* the command ran but failed — show stderr */ }
const repo = JSON.parse(stdout);

// Background: long/live command, opts.background + callbacks, returns { kill() }
cockpit.bash("tail -f ./build.log", { background: true, onOutput: c => { /* … */ } });
```

For a complex backend (multi-step, DB writes), have the AI write a **script file** next to the page and call it with `cockpit.bash("node ./api.js")` — CGI-style: the page renders, the script handles the backend.

> **⚠️ Previewing runs the file.** `cockpit.bash` is a real command-execution channel — equivalent to a shell on your machine. Previewing a local `.html` in Cockpit **executes its scripts with your privileges**, exactly as risky as running the file yourself. So don't preview or bookmark an `.html` you don't trust — an unknown/third-party page can do anything you can from a terminal. (It still obeys Cockpit's startup token gate: open on localhost without `--token`, validated when one is set.)

## Opening and bookmarking

Once generated, you have a few entry points:

- **Chat preview modal**: click the reply to preview. Top-right has two buttons — **Add to HTML panel** (bookmark icon) and **Open in Console bubble** (external-link icon).
- **Explorer file browser**: select any `.html` to read its **source**; click **Preview** to render and run it — HTML never auto-previews, so that click is what grants the page its SDK. The toolbar has the same two buttons.
- **Console browser bubble**: a persistent place to keep an app running across the session. Every preview now runs with the SDK (chat modal, Explorer, bubble) — the bubble just survives tab switches.

### The HTML panel

The **window icon** button at the far left of the Console input bar opens the panel: a card grid of every app you've bookmarked (each card's name / description / icon come from the page's `<head>` meta). Each card can **preview**, **delete**, and **copy path**; click the card body to open it in a Console bubble. Invalid entries (file deleted / moved) are greyed out and marked `Invalid`.

The panel records **absolute paths** only; the registry lives in `~/.cockpit/html.json` (same mechanism as `skills.json`). The HTML files themselves stay in your project — the panel is just a bookmark folder.

### Quick-open with `/name`

Type `/` in the Console input bar and registered apps appear **ahead of** custom commands (tagged with a blue `HTML` label); select or press Enter to open one in a bubble. The short name is the `cockpit-name` from the page meta. It never intercepts real commands — `/usr/bin/x` is still treated as a path.

## Next

- [Skills](/en/docs/agent/skills/) — the `/` command menu `/html` lives in
- [Workflows](/en/docs/agent/workflows/) — chaining commands into ordered steps
- [Browser bubbles](/en/docs/console/browser/) — where HTML apps run
