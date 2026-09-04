#!/usr/bin/env node

/**
 * cockpit browser <id> <action> [args...]
 *
 * CLI entry point: parse arguments, send commands to browser bubble via HTTP API, print results.
 *
 * Usage examples:
 *   cockpit browser abcd snapshot
 *   cockpit browser abcd navigate --url https://example.com
 *   cockpit browser abcd click --ref e5
 *   cockpit browser abcd type --ref e3 --text "hello"
 *   cockpit browser abcd evaluate --js "return document.title"
 *   cockpit browser abcd evaluate --all-frames --js "return document.title"
 *   cockpit browser abcd console --level error
 *   cockpit browser abcd network --status 4xx,5xx
 *   cockpit browser abcd assert --ref e5 --visible true
 *   cockpit browser abcd perf --metric timing
 *   cockpit browser abcd list   (list all connected browsers)
 */

import {
  TIMEOUT_MSG,
  CONNECT_REFUSED_MSG,
  CLICK_NO_OP_WARN,
  HELP_WHEN_NOT_TO_USE,
  HELP_INTERACTION_BY_SELECTOR,
  HELP_FETCH,
  HELP_HEALTH,
  HELP_WAIT,
  HELP_ASSERT,
  HELP_LIFECYCLE,
} from './cock-browser.messages.mjs';

const args = process.argv.slice(2);

// Help text
// status: { connected, title, url } — when passed, display current browser status
function printHelp(prefix = '<id>', status = null) {
  console.log(`Control a Chrome tab — inspect elements, navigate, interact, and debug.

Usage: cockpit browser ${prefix} <action>`);

  if (status) {
    if (status.connected) {
      let line = `\nStatus: connected`;
      if (status.title) line += `\n  title: ${status.title}`;
      if (status.url) line += `\n  URL: ${status.url}`;
      console.log(line);
    } else {
      console.log(`\nStatus: disconnected`);
    }
  }

  console.log(`
── React / SPA gotchas ────────────────────────────────
On modern SPAs (React, Vue, tiptap, ProseMirror, Lexical, Slate, …)
\`type\` / \`click\` via CDP often silently no-op because the framework
ignores raw key/mouse events and reacts only to its own synthetic
event flow. When typing into a contenteditable / controlled input,
or clicking a button rendered by a portal, **prefer \`evaluate\`**.

Three templates that always work:

  # 1) Fill a contenteditable (tiptap / ProseMirror / Lexical):
  evaluate "(() => { const el = document.querySelector('[contenteditable=\\"true\\"]'); el.focus(); document.execCommand('insertText', false, 'hello'); return el.innerText; })()"

  # 2) Set a React-controlled <input> via the native setter + input event:
  evaluate "(() => { const el = document.querySelector('input[name=foo]'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, 'hello'); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()"

  # 3) Click a button by visible text or aria-label (refs go stale on re-render):
  click --text "Sign in"                          # preferred shortcut
  click --selector 'button[type="submit"]'        # exact selector
  evaluate "(() => document.querySelector('button[aria-label=\\"Save\\"]').click())()"  # last resort

Refs returned by \`snapshot\` are \`e<N>#v<epoch>\` — valid only until
the next snapshot or re-render. The error message
\`Element ref "..." is stale (current snapshot v=N)\` tells you to
re-snapshot OR use \`click --text\` / \`click --selector\` /
\`fill --selector\` for re-render-resilient interaction.

──────────────────────────────────────────────────────

Bubbles (create / destroy — no <id> needed for open):
  cockpit browser open <url> [--cwd PATH] [--wait-ms N]
                              Open a console browser bubble in the project that
                              owns --cwd (default: shell cwd), auto-register its
                              bridge, and print the shortId to drive it with.
                              Exit 2 if no Cockpit UI picked it up (bubble is
                              persisted, but nothing is driving it yet).
  cockpit browser <id> close [--cwd PATH]
                              Close the bubble and remove it from the console.

Navigation:
  navigate <url>              Navigate to URL
  reload [--noCache]          Reload page
  back / forward              Navigate history
  url                         Get current URL
  title                       Get page title

Inspection:
  snapshot                    a11y tree (refs like e5#v3; banner explains format)
                              --filter <regex>           server-side grep
                              --include-hidden-text      surface collapsed <summary>/container text
                              --max-depth N              limit walk depth (default 12)
  screenshot                  PNG saved to /tmp; path printed for Read tool

${HELP_INTERACTION_BY_SELECTOR(prefix)}

  type <ref> <text>           Type into ref (CDP key events; React-controlled may silently miss → use fill --selector)
  hover <ref>                 Hover element
  focus <ref>                 Focus element
  scroll --direction D        Scroll page (up/down/left/right)
  key <key>                   Press key (e.g. Enter, Ctrl+A)

${HELP_WAIT}

${HELP_ASSERT}

${HELP_LIFECYCLE}

${HELP_FETCH}

${HELP_HEALTH}

DOM:
  computed <ref>              Get computed styles
  bounds <ref>                Get element bounding rect
  attrs <ref>                 Get element attributes
  events <ref>                Get event listeners
  evaluate <js>               Run JavaScript and return result
                              e.g. evaluate "document.title"
                              e.g. evaluate "await fetch('/api/data').then(r=>r.json())"
                              Tip: fetch() inherits the browser's auth session
                              Use --all-frames to run in all iframes

Network:
  network [--status S]        List requests (--method --type --clear)
  network_record start        Record request bodies (--url --method --status)
  network_record stop         Stop recording
  network_detail <reqId>      Get request/response detail

Console & Debug:
  console [--level L]         Get console messages (--clear)
  perf --metric M             Performance (timing|memory|resources)
  theme --mode M              Switch theme (dark|light)
  cookies                     Get cookies
  storage [--type T]          Get storage (local|session)

${HELP_WHEN_NOT_TO_USE}

── Next step ──────────────────────────────────────────
Run \`cockpit browser ${prefix} snapshot\` to inspect the page.
It returns an element tree with refs like [e5]. Use those
refs to interact: click, type, fill, hover, etc.

Example session:
  cockpit browser ${prefix} snapshot              # 1. see the page
  cockpit browser ${prefix} click e5              # 2. click a button
  cockpit browser ${prefix} type e3 "hello"       # 3. type into input
  cockpit browser ${prefix} evaluate "document.title"  # run JS
  cockpit browser ${prefix} evaluate "await fetch('/api/data').then(r=>r.json())"
        # fetch() inherits the browser's auth session — use it to
        # call APIs, inspect responses, or pull data for analysis.`);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printHelp();
  process.exit(0);
}

// Parse arguments
let id, action;

if (args[0] === 'list') {
  id = null;
  action = 'list';
} else if (args[0] === 'open') {
  // `open` creates a bubble rather than addressing one, so the first token is
  // the action, not an id. (A shortId is also four lowercase letters, so `open`
  // and `list` are in principle collidable — the same trade-off `list` already
  // makes; a colliding bubble is still reachable via every other action.)
  id = null;
  action = 'open';
} else {
  id = args[0];
  action = args[1];

  if (!action || action === '--help' || action === '-h') {
    // Only id provided without action (or --help) → show status + help
    action = '_status';
  }
}

// Parse flags: --key value pairs
function parseFlags(flagArgs) {
  const params = {};
  let i = 0;
  while (i < flagArgs.length) {
    const arg = flagArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = flagArgs[i + 1];

      // Boolean flag (no next argument, or next is also a --flag)
      if (!next || next.startsWith('--')) {
        params[key] = true;
        i++;
      } else {
        // Try parsing as number/boolean/JSON
        let value = next;
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^\d+$/.test(value)) value = parseInt(value);
        else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
        else {
          // Try JSON parsing (arrays, objects)
          try { value = JSON.parse(value); } catch { /* keep as string */ }
        }
        params[key] = value;
        i += 2;
      }
    } else {
      // Positional argument: first one is shorthand for ref or url
      if (!params._positional) params._positional = [];
      params._positional.push(arg);
      i++;
    }
  }
  return params;
}

const params = parseFlags(args.slice(action === 'list' || action === 'open' ? 1 : 2));

// Positional argument handling: some commands treat the first positional as a special value
if (params._positional?.length) {
  const pos = params._positional;
  if (action === 'navigate' && !params.url) params.url = pos[0];
  if (action === 'open' && !params.url) params.url = pos[0];
  // click: positional is the ref (or text fallback for convenience if it does
  // not look like a ref). Refs match e<N>#v<M>; anything else is treated as
  // visible text so `click "Sign in"` Just Works.
  if (action === 'click') {
    if (!params.ref && !params.text && !params.selector) {
      if (/^e\d+#v\d+$/.test(pos[0])) params.ref = pos[0];
      else params.text = pos[0];
    }
  }
  if (action === 'type' && !params.ref) { params.ref = pos[0]; if (pos[1] && !params.text) params.text = pos[1]; }
  // fill: positional[0] is ref (when matches ref pattern) else --selector form.
  // positional[1] is the value when ref-positional is used.
  if (action === 'fill') {
    if (!params.ref && !params.selector) {
      if (/^e\d+#v\d+$/.test(pos[0])) {
        params.ref = pos[0];
        if (pos[1] && !params.value) params.value = pos[1];
      } else {
        // First positional taken as selector if it contains CSS-y chars.
        params.selector = pos[0];
        if (pos[1] && !params.value) params.value = pos[1];
      }
    } else if (params.selector && !params.value && pos[0]) {
      params.value = pos[0];
    }
  }
  if (action === 'hover' && !params.ref) params.ref = pos[0];
  if (action === 'focus' && !params.ref) params.ref = pos[0];
  if (action === 'evaluate' && !params.js) params.js = pos[0];
  // --all-frames → allFrames（kebab-case → camelCase）
  if (action === 'evaluate' && params['all-frames']) { params.allFrames = true; delete params['all-frames']; }
  if (action === 'wait' && !params.text && !params.ref && !params.url && !params.time) params.text = pos[0];
  if (action === 'computed' && !params.ref) params.ref = pos[0];
  if (action === 'bounds' && !params.ref) params.ref = pos[0];
  if (action === 'attrs' && !params.ref) params.ref = pos[0];
  if (action === 'events' && !params.ref) params.ref = pos[0];
  if (action === 'network_detail' && !params.id) params.id = parseInt(pos[0]);
  if (action === 'network_record' && !params.action) params.action = pos[0] || 'status';
  if (action === 'fetch' && !params.url) params.url = pos[0];
  if (action === 'health' && pos[0] === '--deep') params.deep = true;
  delete params._positional;
}

// kebab → camel for new Phase 2 flags.
if (params['network-idle']) { params.networkIdle = true; delete params['network-idle']; }
if (params['dom-stable']) { params.domStable = true; delete params['dom-stable']; }
if (params['extension-ready']) { params.extensionReady = true; delete params['extension-ready']; }
if (params['quiet-ms'] != null) { params.quietMs = params['quiet-ms']; delete params['quiet-ms']; }
if (params['max-request-age-ms'] != null) { params.maxRequestAgeMs = params['max-request-age-ms']; delete params['max-request-age-ms']; }
if (params['fetch-status'] != null) { params.fetchStatus = params['fetch-status']; delete params['fetch-status']; }
if (params['fetch-method']) { params.fetchMethod = params['fetch-method']; delete params['fetch-method']; }
if (params['not-contains'] !== undefined) { params.notContains = params['not-contains']; delete params['not-contains']; }
if (params['no-cache']) { params.noCache = true; delete params['no-cache']; }
if (params['console-no-errors']) { params.consoleNoErrors = true; delete params['console-no-errors']; }
if (params['same-site']) { params.sameSite = params['same-site']; delete params['same-site']; }
if (params['http-only']) { params.httpOnly = true; delete params['http-only']; }
if (params['verify-ms'] != null) { params.verifyMs = Number(params['verify-ms']); delete params['verify-ms']; }
if (params['wait-ms'] != null) { params.waitMs = Number(params['wait-ms']); delete params['wait-ms']; }

// kebab → camel for flags that the extension expects camel.
if (params['include-hidden-text']) { params.includeHiddenText = true; delete params['include-hidden-text']; }
if (params['max-depth'] != null) { params.maxDepth = params['max-depth']; delete params['max-depth']; }
if (params['form-selector']) { params.formSelector = params['form-selector']; delete params['form-selector']; }
if (params['skip-verify']) { params.skipVerify = true; delete params['skip-verify']; }
if (params['no-verify']) { params.skipVerify = true; delete params['no-verify']; }

// Port: env COCKPIT_PORT > <COCKPIT_HOME|~/.cockpit>/server.json > default 3457
let port = process.env.COCKPIT_PORT || 3457;
if (!process.env.COCKPIT_PORT) {
  try {
    const { readFileSync } = await import('fs');
    const { join, resolve } = await import('path');
    const { homedir } = await import('os');
    // COCKPIT_HOME-aware: must match where the server wrote server.json (server.mjs).
    const dir = process.env.COCKPIT_HOME
      ? resolve(process.env.COCKPIT_HOME.replace(/^~(?=$|\/)/, homedir()))
      : join(homedir(), '.cockpit');
    const serverJson = JSON.parse(readFileSync(join(dir, 'server.json'), 'utf8'));
    if (serverJson.port) port = serverJson.port;
  } catch {}
}
delete params.port;
const baseUrl = `http://localhost:${port}`;
// `open` blocks server-side until the bubble registers (--wait-ms); the HTTP
// timeout has to outlast that wait or the CLI aborts a request that was about
// to succeed.
const timeout = params.timeout
  || (action === 'open' && params.waitMs > 10000 ? params.waitMs + 5000 : 15000);
delete params.timeout;

// The CLI name to suggest in output: dev server (3456) is only reachable via
// `cockpit-dev`, which has no short alias.
const cockBin = String(port) === '3456' ? 'cockpit-dev' : 'cockpit';

// `open` / `close` address a project on disk rather than a live page, so they
// need a cwd. Default to where the shell is standing; the server walks up from
// there to the project that actually owns the console.
if ((action === 'open' || action === 'close') && !params.cwd) {
  params.cwd = process.cwd();
}

// Quickly fetch browser url and title (2s timeout, silently return empty on failure)
async function fetchBrowserInfo(shortId) {
  try {
    const [urlRes, titleRes] = await Promise.all([
      fetch(`${baseUrl}/api/browser/url`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: shortId, params: {}, timeout: 2000 }),
        signal: AbortSignal.timeout(3000),
      }).then(r => r.json()),
      fetch(`${baseUrl}/api/browser/title`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: shortId, params: {}, timeout: 2000 }),
        signal: AbortSignal.timeout(3000),
      }).then(r => r.json()),
    ]);
    return {
      url: urlRes.ok ? urlRes.data : '',
      title: titleRes.ok ? titleRes.data : '',
    };
  } catch {
    return { url: '', title: '' };
  }
}

// Chunked evaluate result resolver
//
// Chrome extension runtime messaging has an implicit ~8 KiB structured-clone
// truncation point at the sendResponse boundary. To keep large evaluate
// results from being silently cut off, the extension side stashes any result
// >6 KiB in a Map on the page window and returns a
// { __cockpit_chunked: true, token, totalBytes, isString } descriptor.
// Whenever we see that descriptor here, we pull the full payload back via
// the evaluate_chunk action — fully transparent to formatOutput above.
async function fetchOneChunk(baseUrl, id, token, offset, cmdTimeout) {
  const resp = await fetch(`${baseUrl}/api/browser/evaluate_chunk`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      id,
      params: { token, offset, size: 5000 },
      timeout: Math.max(5000, Math.min(cmdTimeout, 15000)),
    }),
    signal: AbortSignal.timeout(20000),
  });
  const j = await resp.json();
  if (!j.ok) throw new Error(`evaluate_chunk HTTP failed: ${j.error || 'unknown'}`);
  const r = j.data;
  if (!r || r.error) throw new Error(`evaluate_chunk error: ${r?.error || 'empty response'}`);
  return r; // { chunk, done, nextOffset, totalBytes, isString }
}

async function resolveChunkedDescriptor(baseUrl, id, descriptor, cmdTimeout) {
  const { token, totalBytes, isString } = descriptor;
  const parts = [];
  let offset = 0;
  let iterations = 0;
  while (offset < totalBytes) {
    if (++iterations > 2000) throw new Error('evaluate chunking: too many iterations (>2000)');
    const r = await fetchOneChunk(baseUrl, id, token, offset, cmdTimeout);
    parts.push(r.chunk);
    offset = r.nextOffset;
    if (r.done) break;
  }
  const full = parts.join('');
  if (isString) return full;
  try {
    return JSON.parse(full);
  } catch (err) {
    throw new Error(`evaluate chunking: concatenated payload is not valid JSON (${err.message}); raw length=${full.length}`);
  }
}

async function autoResolveChunked(baseUrl, id, data, cmdTimeout) {
  if (data && typeof data === 'object') {
    if (data.__cockpit_chunked === true && typeof data.token === 'string') {
      return await resolveChunkedDescriptor(baseUrl, id, data, cmdTimeout);
    }
    // With allFrames=true the aggregate may be an array, and each element
    // may be independently chunked
    if (Array.isArray(data)) {
      return Promise.all(data.map(item => autoResolveChunked(baseUrl, id, item, cmdTimeout)));
    }
  }
  return data;
}

// Send request
// F2.7 — wait --extension-ready: poll the cheap server-side health endpoint
// until the bridge reports quiet conditions for `quietMs` consecutive ms.
// Replaces the manual `until cockpit browser X evaluate "1+1"` loop that AI
// has historically used when an evaluate hangs on a busy page.
async function waitExtensionReady({ quietMs = 500, timeoutMs = 60000 }) {
  const start = Date.now();
  let quietSince = null;
  while (Date.now() - start < timeoutMs) {
    let h = null;
    try {
      const r = await fetch(`${baseUrl}/api/browser/health`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, params: {}, timeout: 1000 }),
        signal: AbortSignal.timeout(2000),
      });
      const j = await r.json();
      h = j.ok ? j.data : null;
    } catch { /* network blip — treat as not-ready */ }
    const ready = h && h.found && h.ws === 'open' && h.pendingCommands === 0;
    if (ready) {
      if (quietSince == null) quietSince = Date.now();
      if (Date.now() - quietSince >= quietMs) {
        return { waited: `extension-ready (quiet=${quietMs}ms)`, elapsedMs: Date.now() - start };
      }
    } else {
      quietSince = null;
    }
    await new Promise(r => setTimeout(r, 100));
  }
  throw new Error(
    `wait --extension-ready timed out after ${timeoutMs}ms.\n` +
    `  The bridge never reported quiet for ${quietMs}ms.\n` +
    `  Consider a service-level test if the page is driven by an async LLM/agent flow.`
  );
}

async function run() {
  // Only id provided without action → show help + status
  if (action === '_status') {
    let status = null;
    try {
      const res = await fetch(`${baseUrl}/api/browser/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const browser = data.ok && data.data?.find(b => b.shortId === id);
      if (browser) {
        if (browser.connected) {
          const info = await fetchBrowserInfo(browser.shortId);
          status = { connected: true, title: info.title, url: info.url };
        } else {
          status = { connected: false };
        }
      }
    } catch {
      // server unreachable — show help without status
    }
    printHelp(id, status);
    return;
  }

  // F2.7 — wait --extension-ready runs entirely CLI-side: it polls the cheap
  // server-side `health` endpoint, so it works even when the page is blocked.
  if (action === 'wait' && params.extensionReady) {
    try {
      const r = await waitExtensionReady({
        quietMs: params.quietMs ?? 500,
        timeoutMs: timeout,
      });
      console.log(`waited: ${r.waited} (elapsed ${formatMs(r.elapsedMs)})`);
      return;
    } catch (err) {
      console.error(err.message);
      process.exit(1);
    }
  }

  const url = `${baseUrl}/api/browser/${action}`;
  const body = { id, params, timeout };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout + 5000), // HTTP timeout is 5s more than command timeout
    });

    const data = await response.json();

    if (!data.ok) {
      console.error(data.error || 'Unknown error');
      if (data.debug) console.error('Debug:', JSON.stringify(data.debug, null, 2));
      process.exit(1);
    }

    // Large results are auto-stashed by the extension side, which returns a
    // chunked descriptor; we transparently pull the full content back here —
    // callers never see the chunking.
    const resolved = await autoResolveChunked(baseUrl, id, data.data, timeout);

    // Post-`type` verification — `type` via CDP dispatchKeyEvent silently no-ops
    // on React-controlled / contenteditable inputs (tiptap, ProseMirror, Lexical,
    // Slate, etc.) because those frameworks update state from synthetic
    // InputEvents rather than physical key events. The CLI used to return
    // `{typed, ref}` regardless, lying about the result. Now we read back the
    // currently-focused element's value/textContent and compare; mismatches
    // exit 1 with a pointer to the evaluate workaround. Session 0a975cff
    // burned 4 extra bash calls discovering this silently.
    //
    // We use document.activeElement because `type` focuses the target as its
    // first step — so right after a successful type, activeElement IS the
    // target. The Playwright "ref" (e555 etc.) has no DOM-side equivalent, so
    // we can't query for it directly.
    if (action === 'type' && params.ref && typeof params.text === 'string') {
      const expected = String(params.text);
      let actual = '';
      let kind = 'unknown';
      try {
        const verifyJs =
          '(() => { const el = document.activeElement; ' +
          'if (!el || el === document.body) return { kind: "no-active", text: "" }; ' +
          'const tag = el.tagName ? el.tagName.toLowerCase() : ""; ' +
          'if (tag === "input" || tag === "textarea") return { kind: tag, text: el.value || "" }; ' +
          'if (el.isContentEditable) return { kind: "contenteditable", text: el.innerText || el.textContent || "" }; ' +
          'return { kind: tag || "unknown", text: (el.textContent || "").slice(0, 500) }; })()';
        const v = await fetch(`${baseUrl}/api/browser/evaluate`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ id, params: { js: verifyJs }, timeout: 3000 }),
          signal: AbortSignal.timeout(5000),
        });
        const vj = await v.json();
        const out = vj.ok && vj.data;
        if (out && typeof out === 'object') {
          kind = out.kind;
          actual = String(out.text || '');
        }
      } catch {
        // verification optional — fall through to printing the original result
      }

      // Only warn on KNOWN editable types whose value/text doesn't contain what
      // we typed. "no-active" / "unknown" we can't reliably verify, so we skip
      // (no false positives).
      const verifiable = kind === 'input' || kind === 'textarea' || kind === 'contenteditable';
      if (verifiable && !actual.includes(expected)) {
        // Type "succeeded" per CDP but the target didn't pick up the text.
        // Almost always a React-controlled / contenteditable input.
        process.stderr.write(
          `\n⚠️  type succeeded per CDP but the target's value/textContent does NOT contain "${expected}".\n` +
          `   target kind: ${kind}, current text: ${JSON.stringify(actual).slice(0, 200)}\n` +
          `   This is usually a React-controlled or contenteditable input (tiptap / ProseMirror / Lexical / Slate)\n` +
          `   where CDP key events don't trigger framework state updates.\n` +
          `\n` +
          `   Fix: use \`evaluate\` to drive the framework's own event flow, e.g.\n` +
          `     cockpit browser ${id} evaluate "(() => { const el = document.querySelector('[contenteditable=\\\"true\\\"]'); el.focus(); document.execCommand('insertText', false, ${JSON.stringify(expected)}); return el.innerText; })()"\n` +
          `\n   For a plain <input>, set value via property setter + dispatch an 'input' event:\n` +
          `     evaluate "(() => { const el = document.querySelector('input[name=foo]'); const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set; set.call(el, ${JSON.stringify(expected)}); el.dispatchEvent(new Event('input', { bubbles: true })); return el.value; })()"\n`
        );
        await formatOutput(action, resolved);
        process.exit(1);
      }
    }

    // F1.7 — post-verify silent failures for click / key / submit.
    if (POST_VERIFY_ACTIONS.has(action)) {
      try { await postVerify(action, params, resolved); } catch { /* never fail the command */ }
    }

    // Format output
    await formatOutput(action, resolved);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.code === 'ABORT_ERR') {
      console.error(TIMEOUT_MSG(timeout, id));
    } else if (err.cause?.code === 'ECONNREFUSED') {
      console.error(CONNECT_REFUSED_MSG(baseUrl));
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

// F1.7 — Post-verify for click / key / submit. CDP reports "success" even when
// the framework didn't react. Diff a cheap state probe before and after; if
// nothing observable changed in the window, warn with actionable templates.
//
// Default window: 1000ms (BL-1, observation period). Was 200ms but dogfood
// showed false positives on React pages whose batched re-renders + XHR fire
// took >200ms to surface. Users can override per command with --verify-ms;
// --skip-verify (or --no-verify) opts out entirely.
const POST_VERIFY_ACTIONS = new Set(['click', 'key', 'submit']);
const POST_VERIFY_WINDOW_MS_DEFAULT = 1000;

async function probeState() {
  const r = await fetch(`${baseUrl}/api/browser/probe_state`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id, params: {}, timeout: 2000 }),
    signal: AbortSignal.timeout(3000),
  });
  const j = await r.json();
  return j.ok ? j.data : null;
}

async function postVerify(action, params, originalResolved) {
  if (params.skipVerify) return;
  const windowMs = Number.isFinite(params.verifyMs) && params.verifyMs > 0
    ? params.verifyMs
    : POST_VERIFY_WINDOW_MS_DEFAULT;
  let before;
  try { before = await probeState(); } catch { return; }
  if (!before) return;
  await new Promise(r => setTimeout(r, windowMs));
  let after;
  try { after = await probeState(); } catch { return; }
  if (!after) return;
  const urlChanged = before.url !== after.url;
  const domChanged = before.domHash !== after.domHash || before.domLen !== after.domLen;
  const newRequests = after.lastNetworkId > before.lastNetworkId;
  if (!urlChanged && !domChanged && !newRequests) {
    process.stderr.write(
      '\n' +
      CLICK_NO_OP_WARN(action, id, {
        windowMs,
        urlChanged,
        domChanged,
        newRequests,
      }) +
      '\n'
    );
  }
}

async function formatOutput(action, data) {
  if (data === undefined || data === null) {
    // evaluate-family silently returning undefined/null is a major source of
    // confusion for LLM callers — they can't tell "code ran but produced no
    // value" from "something broke". Write a concrete hint to stderr so the
    // Bash tool's empty-stdout annotation surfaces it alongside the
    // "(exit 0 — empty stdout)" note instead of guessing causes.
    if (action === 'evaluate' || action === 'evaluate_chunk') {
      process.stderr.write(
        `(evaluate returned ${data === null ? 'null' : 'undefined'} — nothing to print.\n` +
        ` Common causes:\n` +
        `  (a) bare arrow function: \`() => x\` defines but does not invoke — wrap as \`(() => x)()\` or \`(async()=>{...})()\`.\n` +
        `  (b) a .then(...) callback didn't return the value — add an explicit \`return\` in each step of the chain.\n` +
        `  (c) accessed a missing property — e.g. \`d.chat.x\` when response has no \`chat\` field, yielding undefined.\n` +
        ` To force output: wrap the final value with \`JSON.stringify(...)\`, or return a short scalar.\n`
      );
    }
    return;
  }
  if (typeof data === 'function') {
    // Structured clone usually drops functions into undefined before this
    // point, but if one slips through (e.g. from a custom bridge), surface
    // it explicitly instead of swallowing.
    process.stderr.write(
      `(evaluate returned a function reference, which cannot be serialized.\n` +
      ` If you defined an arrow function, invoke it: \`(async()=>{...})()\`.\n` +
      ` To return the function's *result*, call it; to inspect the source, use \`fn.toString()\`.\n`
    );
    return;
  }

  // Special formatting
  switch (action) {
    case 'open':
      console.log(
        data.registered
          ? `${data.shortId}  →  registered and ready`
          : `${data.shortId}  →  created, but NOT registered`
      );
      console.log(`  url:     ${data.url}`);
      console.log(`  project: ${data.projectCwd}`);
      if (data.registered) {
        console.log(`  next:    ${cockBin} browser ${data.shortId} snapshot`);
        console.log(`  close:   ${cockBin} browser ${data.shortId} close`);
      } else {
        console.log(
          `\n  No Cockpit UI applied the bubble, so nothing is driving it.\n` +
          `  The entry is persisted — it will appear when this project is next\n` +
          `  opened in Cockpit. Open the project (or check --cwd) and retry.`
        );
        process.exit(2);
      }
      return;

    case 'close':
      console.log(
        data.removed
          ? `closed ${data.shortId}`
          : `closed ${data.shortId} (no persisted entry — nothing to remove)`
      );
      return;

    case 'snapshot':
      // a11y tree: output as plain text
      console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      return;

    case 'url':
    case 'title':
    case 'cookies':
      // Simple values: output directly
      console.log(data);
      return;

    case 'health':
      // Server-side bridge health snapshot.
      if (!data.found) {
        console.log(`browser "${id}" not registered (no bubble open?)`);
        process.exit(2);
      }
      console.log(
        `extension: ${data.ws === 'open' ? 'alive (ws=open)' : 'unreachable (ws=' + data.ws + ')'}` +
        `   pending: ${data.pendingCommands}` +
        (data.lastSuccessMs !== null
          ? `   last-success: ${formatMs(data.lastSuccessMs)} ago (${data.lastSuccessAction || '?'})`
          : '   last-success: never')
      );
      return;

    case 'fetch':
      // Default: pretty JSON. If jsonpath was used, print the extracted value plainly.
      if (data && typeof data === 'object' && 'jsonpath' in data) {
        console.log(`[${data.status}] ${data.jsonpath} =`);
        console.log(typeof data.value === 'object' ? JSON.stringify(data.value, null, 2) : data.value);
      } else if (data && typeof data === 'object' && 'data' in data) {
        console.log(`[${data.status}] (${data.contentType || 'unknown'})`);
        console.log(typeof data.data === 'object' ? JSON.stringify(data.data, null, 2) : data.data);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      return;

    case 'submit':
      console.log(`submitted: ${data.submitted}${data.action ? `   → ${data.action}` : ''}`);
      return;

    case 'wait':
      // Extension returned a structured ack — print one line summary.
      if (data && data.waited) {
        console.log(`waited: ${data.waited}${data.elapsedMs != null ? ` (elapsed ${formatMs(data.elapsedMs)})` : ''}`);
        return;
      }
      break;

    case 'reset':
      if (data && Array.isArray(data.cleared)) {
        console.log(`cleared: ${data.cleared.join(', ') || '(nothing)'}`);
        if (data.errors?.length) {
          for (const e of data.errors) process.stderr.write(`  ⚠ ${e}\n`);
          process.exit(1);
        }
        return;
      }
      break;

    case 'set':
      if (data && data.set) {
        const note = data.verified === false
          ? '   ⚠ cookie was not accepted (different domain / SameSite / Secure?)'
          : data.length != null ? `   (${data.length} bytes)` : '';
        console.log(`set ${data.set}: ${data.name}${note}`);
        if (data.verified === false) process.exit(1);
        return;
      }
      break;

    case 'status':
      if (data && data.url != null) {
        console.log(`URL:    ${data.url}`);
        console.log(`Title:  ${data.title}   [${data.readyState}]`);
        if (data.lastConsoleError) {
          console.log(`Last console error:  ${data.lastConsoleError.text}   (${data.lastConsoleError.ageSec}s ago)`);
        }
        if (data.lastFailedRequest) {
          const r = data.lastFailedRequest;
          console.log(`Last failed request: ${r.method} ${r.url} [${r.status}]   (${r.ageSec}s ago)`);
        }
        if (Array.isArray(data.topActions) && data.topActions.length) {
          console.log(`Top actions:         ${data.topActions.map(a => `"${a}"`).join('  ')}`);
        }
        return;
      }
      break;

    case 'screenshot':
      if (data.image) {
        // data URL → save as PNG file, output path (for Read tool to view)
        const { writeFileSync } = await import('fs');
        const { tmpdir } = await import('os');
        const { join } = await import('path');
        const base64 = data.image.replace(/^data:image\/\w+;base64,/, '');
        const filePath = join(tmpdir(), `cockpit-screenshot-${id}-${Date.now()}.png`);
        writeFileSync(filePath, Buffer.from(base64, 'base64'));
        console.log(filePath);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      return;

    case 'list':
      if (Array.isArray(data) && data.length === 0) {
        console.log('No browsers connected');
        return;
      }
      if (Array.isArray(data)) {
        const infos = await Promise.all(data.map(b =>
          b.connected ? fetchBrowserInfo(b.shortId) : { url: '', title: '' }
        ));
        for (let i = 0; i < data.length; i++) {
          const b = data[i];
          const info = infos[i];
          const status = b.connected ? '●' : '○';
          let line = `${status} ${b.shortId}  ${b.connected ? 'connected' : 'disconnected'}`;
          if (info.title) line += `  title: ${info.title}`;
          if (info.url) line += `\n    URL: ${info.url}`;
          console.log(line);
        }
        return;
      }
      break;

    case 'assert':
      if (data.pass) {
        console.log('PASS');
      } else {
        console.error('FAIL');
        for (const f of (data.failures || [])) {
          console.error(`  - ${f}`);
        }
        process.exit(1);
      }
      return;

    case 'console':
      if (Array.isArray(data)) {
        for (const m of data) {
          const ts = new Date(m.timestamp).toLocaleTimeString();
          console.log(`[${ts}] [${m.level}] ${m.text}`);
        }
        return;
      }
      break;

    case 'network':
      if (Array.isArray(data)) {
        for (const r of data) {
          const status = r.status || '???';
          const dur = r.duration ? `${r.duration}ms` : '...';
          const size = r.size ? ` ${r.size > 1024 ? (r.size / 1024).toFixed(1) + 'K' : r.size + 'B'}` : '';
          const rec = r.recorded ? ' ●' : '';
          console.log(`[${r.id}] ${r.method} ${r.url} ${status} ${dur}${size}${rec}`);
        }
        if (data.length === 0) console.log('(no requests)');
        return;
      }
      break;

    case 'network_record':
      if (data && !data.error) {
        if (data.recording === true && data.filters) {
          const filters = Object.entries(data.filters).map(([k, v]) => `${k}=${v}`).join(' ') || '(all)';
          console.log(`⏺ Recording started  filters: ${filters}  expires: ${data.expiresIn}`);
        } else if (data.recording === false && data.recordedCount !== undefined) {
          console.log(`⏹ Recording stopped  ${data.recordedCount} requests captured`);
        } else {
          // status
          const state = data.recording ? `⏺ Recording (${data.elapsed})` : '⏹ Stopped';
          const filters = data.filters && Object.keys(data.filters).length
            ? Object.entries(data.filters).map(([k, v]) => `${k}=${v}`).join(' ')
            : '(all)';
          console.log(`${state}  filters: ${filters}  recorded: ${data.recordedCount}/${data.totalCount}`);
        }
        return;
      }
      break;

    case 'network_detail':
      if (data && !data.error) {
        console.log(`${data.method} ${data.url}`);
        console.log(`Status: ${data.status}  Duration: ${data.duration}ms  Type: ${data.type}\n`);
        if (data.requestHeaders && Object.keys(data.requestHeaders).length) {
          console.log('--- Request Headers ---');
          for (const [k, v] of Object.entries(data.requestHeaders)) console.log(`  ${k}: ${v}`);
        }
        if (data.requestBody) {
          console.log('\n--- Request Body ---');
          console.log(data.requestBody);
        }
        if (data.responseHeaders && Object.keys(data.responseHeaders).length) {
          console.log('\n--- Response Headers ---');
          for (const [k, v] of Object.entries(data.responseHeaders)) console.log(`  ${k}: ${v}`);
        }
        if (data.responseBody) {
          console.log('\n--- Response Body ---');
          console.log(data.responseBody);
        }
        return;
      }
      break;
  }

  // Default: JSON output
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

function formatMs(ms) {
  if (ms < 1000) return `${ms}ms`;
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

// Export promise for external await
export const done = run();
