---
name: html
description: "Generate an interactive local React app wired to the built-in cockpit bash SDK."
argument-hint: "describe the app you want"
---

# Build a Cockpit app (a local React page)

A **local application**, not a one-off page: the preview injects a global `window.cockpit`
SDK — essentially the Bash tool exposed to the page, so buttons can `curl`, read/write files
and run scripts; data lands on disk inside the app directory and is there on reopen.

Zero build: React / Babel load from the same-origin `/html-lib` — no bundler, no deps, works offline.

## 1. Flow: align first, write only after confirmation (important)

**Don't write files up front.** Three steps:

1. **Align on the requirement** — restate your understanding of the app (what it does, where
   data comes from, key features/interactions). Ask back only when the requirement is ambiguous
   or has several reasonable readings; if it's already clear, just give a short summary — don't
   interrogate.
2. **Tell the storage directory** — resolve `<dir>/<name>/` and tell the user exactly where it
   goes and what it's called; they may reject or change it:
   - **You always pick `<name>`** from the request (lowercase kebab-case, matching
     `cockpit-name`) — the user only describes the app, they don't name it.
   - The user gave a directory → `<the given directory>/<name>/`; none given → `<name>/` under
     the **current chat working directory** (this session's cwd).
   - Every file of the app lives in that one directory, with data split into `cache/`
     `state/` `out/` per section 4. Don't scatter files elsewhere or invent a `.cockpit-apps`.
3. **Write only after confirmation** — `Write` the files once the user clearly agrees (confirm /
   start / go / "write it" — any affirmative). Until then, only discuss.

Even if the user already spelled out requirement and directory in the `/html` call, still stop
once to present "understanding + directory + a 'shall I start writing?'" and wait — but keep that
round **lightweight**, don't re-interrogate.

## 2. Skeleton: three files, copy them

`index.html` — use this fixed shell, don't improvise:

```html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Page title</title>
  <meta name="cockpit-name" content="short-name">   <!-- unique short name for /name; letters/digits/-_ -->
  <meta name="description" content="one line about the page">
  <meta name="cockpit-icon" content="🔍">           <!-- emoji or icon url, optional -->
  <meta name="cockpit-theme" content="auto">        <!-- light/dark toggle, see section 5 -->
  <link rel="stylesheet" href="/html-lib/theme.css">
</head>
<body>
  <div id="root"></div>
  <script src="/html-lib/react.production.min.js"></script>
  <script src="/html-lib/react-dom.production.min.js"></script>
  <script src="/html-lib/babel.min.js"></script>
  <script>
    (async () => {
      const src = await (await fetch('./app.jsx')).text();
      // MUST use classic runtime: the default automatic runtime injects an import of
      // react/jsx-runtime, which — appended as a plain script — throws
      // "Cannot use import statement outside a module".
      const { code } = Babel.transform(src, { presets: [['react', { runtime: 'classic' }]] });
      const s = document.createElement('script'); s.textContent = code; document.body.appendChild(s);
    })();
  </script>
</body>
</html>
```

All four meta lines matter: the HTML panel renders cards from them, and the console opens the
app via `cockpit-name` (`/name`).

`app.jsx` — global `React`, render at the end. **Opening reads the cache; only Refresh goes out**:

```jsx
const { useState, useEffect, useCallback } = React;

function App() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async (refresh) => {
    setBusy(true); setErr(null);
    try {
      const arg = btoa(JSON.stringify({ refresh: !!refresh }));      // structured args as base64
      const { stdout, stderr, exitCode } = await cockpit.bash(`node ./api.mjs ${arg}`);
      if (exitCode !== 0) throw new Error(stderr || 'script failed');  // ran, but failed
      const d = JSON.parse(stdout);
      if (d.error && !d.stale) throw new Error(d.error);
      setData(d);
      if (d.stale) setErr(d.error);                                  // old data is still shown
    } catch (e) {
      setErr(e.message);      // a throw = spawn/infra failure. Keep existing data on screen
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(false); }, [load]);       // on open: cache only, zero requests

  if (!data) return <div>{err ?? 'Loading…'}</div>;
  return (
    <div>
      <span>{data.cached ? 'cached' : 'updated'} · {new Date(data.fetchedAt).toLocaleString()}</span>
      <button disabled={busy} onClick={() => load(true)}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      {err && <em>Refresh failed, showing older data: {err}</em>}
      {/* render data */}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
```

`api.mjs` — the backend handler: fetching, parsing and persistence live here; one JSON on stdout:

```js
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE = join(DIR, 'cache/data.json');
const VERSION = 1;          // bump whenever the payload shape changes, or old cache feeds a new UI

const args = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString() || '{}');

function readCache() {
  if (!existsSync(CACHE)) return null;
  const c = JSON.parse(readFileSync(CACHE, 'utf8'));
  return c.v === VERSION ? c : null;          // version mismatch = void it, act as if empty
}
function writeCache(payload) {
  mkdirSync(dirname(CACHE), { recursive: true });
  const tmp = `${CACHE}.${process.pid}.tmp`;   // atomic: a kill mid-write leaves no half JSON
  writeFileSync(tmp, JSON.stringify({ v: VERSION, fetchedAt: new Date().toISOString(), payload }));
  renameSync(tmp, CACHE);
}

try {
  const hit = args.refresh ? null : readCache();
  if (hit) {
    process.stdout.write(JSON.stringify({ ...hit.payload, cached: true, fetchedAt: hit.fetchedAt }));
  } else {
    const payload = await fetchFresh(args);   // ← your fetching logic (curl / DB / commands)
    writeCache(payload);
    process.stdout.write(JSON.stringify({ ...payload, cached: false, fetchedAt: new Date().toISOString() }));
  }
} catch (e) {
  const hit = readCache();                    // failed refresh: fall back to the old cache, labelled
  process.stdout.write(JSON.stringify(hit
    ? { ...hit.payload, cached: true, stale: true, error: e.message, fetchedAt: hit.fetchedAt }
    : { error: e.message }));
}
```

- When one command is enough and the data isn't worth keeping (just viewing current state), skip
  `api.mjs` and call `cockpit.bash("curl -s …")` directly. The moment data should survive a
  reopen, use this skeleton rather than inventing your own.
- Same for other languages: `python3 ./api.py` / `bash ./api.sh` (explicit interpreter avoids
  `chmod +x`); probe `node` / `python3` with `command -v` if unsure and fall back to shell.
- The cache key must include **every parameter that changes the result** (time range, fetch depth
  …): use `cache/<param>.json` or bucket by key inside the file — otherwise a 7-day cache renders
  in the 30-day view.

## 3. Contract: window.cockpit

The SDK is ready on load — no library to import:

- `cockpit.cwd: string` — directory of the current file; relative-path commands run here.
- `cockpit.bash(command, opts?)` — run one bash command (`command` is a raw shell string):
  - **Foreground** (default, short/discrete) → `Promise<{ stdout, stderr, exitCode }>`; `await` for the full output at once.
  - **Background** (`opts.background: true`, long/live) → `{ kill() }`, streaming via callbacks.
    Large/continuous output **must** use background — foreground buffers it all in memory.

```js
const h = cockpit.bash("npm run build", {
  background: true,
  onOutput: c => append(c),
  onStderr: c => append(c),
  onExit:   code => append('\n[exit ' + code + ']'),   // command finished; non-zero = failed
  onError:  msg  => append('\n[error ' + msg + ']'),   // spawn / infra failure
});
// h.kill() on unmount or when the user aborts
```

Rules every page must follow:

1. **Data only through `cockpit.bash`** (`curl` to read, `curl -X POST` to write, or read/write
   files) — **never `fetch(externalURL)`**: the same-origin sandbox blocks it via CORS.
   (`fetch('./app.jsx')` and other same-directory relative requests are fine.)
2. **Handle both failure modes**: a **throw** caught by `try/catch` = spawn/infra failure (bad
   path, dropped connection); no throw but **`exitCode !== 0` = the command ran and failed** — show
   `stderr` or the error body in stdout, don't just say "failed". Background: `onError` (infra) +
   a non-zero `code` in `onExit` (command).
3. **`command` is a shell string**: validate or escape any dynamic/user input before interpolating
   it (shell metacharacters inject); pass structured input as base64 (see the skeleton) instead of
   string-building; use **parameterized** statements for DB writes.
4. **Resource refs**: relative siblings (`./app.jsx`, `./style.css`, images) and absolute CDN URLs
   load; root-relative (`/assets/x.css`) 404s — the server only hosts `/html-lib/*` and `/apps/*`.

## 4. Local data: three directories

Data must land on disk and be there on reopen — **don't refetch everything on every open**. All
persistence goes through `api.mjs`; inside the app directory, split it by "can this be rebuilt?"
into three directories instead of one flat pile:

- `cache/` — rebuildable (API responses, raw dumps, derived indexes). Deleting it only costs time. **Gitignore the whole directory.**
- `state/` — NOT rebuildable (daily snapshots, hand-maintained lists). The source can't hand it to you twice; deleted means gone. **Commit it.**
- `out/` — artifacts for humans (reports, exports), date-named, kept.

The split only pays off through the git policy: directories separated but `cache/` not ignored and
`state/` not committed means nothing was separated.

What the skeleton already handles (versioning, atomic writes, the `refresh` flag, the fetch
timestamp, stale fallback) isn't repeated here. What's left is on you:

1. **Any growing directory needs a cap enforced in the script** (keep N entries / prune past X MB).
   A cap that lives only in a comment is not a cap — unattended dump directories reach GB scale.
2. **Never write absolute paths into a file on disk** (store paths relative to the app directory),
   or moving the directory voids the index; anything holding private data (emails …) is gitignored.
3. **Provide a clear/reset entry point** (a `clear_cache` mode in `api.mjs` + a button), or the
   user's only option is guessing which file is safe to delete in a file manager.
4. To use another app's credentials / helper scripts, reference them as `../<app>/` and **probe
   that they exist first**; on failure give one actionable line ("log in again at xxx") rather than
   dumping the raw error.

## 5. Theme

Style with the **Cockpit theme** by default (`index.html` already links `/html-lib/theme.css`).
**Fetch that file once before you pick any colour** — it is the single source of truth for the
variables, so don't guess names from memory:

```bash
curl -fsS "{{BASE_URL}}/html-lib/theme.css"
```

- `:root` holds the light values, `.dark` the dark ones. The raw scales (`--slate-*` / `--teal-*` /
  `--red-*` …) store HSL components, so translucency is just `hsl(var(--green-9) / .12)`.
- Take foregrounds in pairs (`--card`/`--card-foreground` …), **except `--brand`**:
  `--brand-foreground` is a tint of the same hue and hits only 1.5:1 on a `--brand` fill — **use
  `var(--background)` for text on a brand fill**.
- The `cockpit-theme` meta gives the preview a floating light/dark toggle (top-right by default,
  draggable to any corner — so don't reserve top-right space for it); it **follows the Cockpit host
  theme by default** (outside Cockpit, the meta's auto/light/dark decides), and a manual toggle is
  **remembered per app across reloads and overrides the host**, or call `cockpit.toggleTheme()`.
- **Don't invent a palette or add Tailwind**; add a small `<style>` for app-specific bits.
