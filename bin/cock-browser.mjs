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
Navigation:
  navigate <url>              Navigate to URL
  reload [--noCache]          Reload page
  back / forward              Navigate history
  url                         Get current URL
  title                       Get page title

Inspection:
  snapshot                    Get element tree (returns refs like [e5])
  screenshot                  Take a screenshot

Interaction (use ref from snapshot):
  click <ref>                 Click element
  type <ref> <text>           Type text into element
  fill <ref> <value>          Fill input value
  hover <ref>                 Hover element
  focus <ref>                 Focus element
  scroll --direction D        Scroll page (up/down/left/right)
  key <key>                   Press key (e.g. Enter, Ctrl+A)
  wait --text T               Wait for text to appear

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

const params = parseFlags(args.slice(action === 'list' ? 1 : 2));

// Positional argument handling: some commands treat the first positional as a special value
if (params._positional?.length) {
  const pos = params._positional;
  if (action === 'navigate' && !params.url) params.url = pos[0];
  if (action === 'click' && !params.ref) params.ref = pos[0];
  if (action === 'type' && !params.ref) { params.ref = pos[0]; if (pos[1] && !params.text) params.text = pos[1]; }
  if (action === 'fill' && !params.ref) { params.ref = pos[0]; if (pos[1] && !params.value) params.value = pos[1]; }
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
  delete params._positional;
}

// Port: env COCKPIT_PORT > ~/.cockpit/server.json > default 3457
let port = process.env.COCKPIT_PORT || 3457;
if (!process.env.COCKPIT_PORT) {
  try {
    const { readFileSync } = await import('fs');
    const { join } = await import('path');
    const { homedir } = await import('os');
    const serverJson = JSON.parse(readFileSync(join(homedir(), '.cockpit', 'server.json'), 'utf8'));
    if (serverJson.port) port = serverJson.port;
  } catch {}
}
delete params.port;
const baseUrl = `http://localhost:${port}`;
const timeout = params.timeout || 15000;
delete params.timeout;

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
// Chrome extension 的 runtime messaging 在 sendResponse 边界有一个 ~8 KiB 的
// 隐性 structured-clone 截断点；为了避免 evaluate 大结果被默默截掉，
// extension 侧会把 >6 KiB 的结果暂存到 page window 上的一个 Map，
// 返回一个 { __cockpit_chunked: true, token, totalBytes, isString } 的
// descriptor。这里遇到 descriptor 就自动走 evaluate_chunk action 把完整
// payload 拉回来，对上层 formatOutput 完全透明。
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
    // allFrames=true 聚合时可能得到数组，每一项都可能是独立 chunked
    if (Array.isArray(data)) {
      return Promise.all(data.map(item => autoResolveChunked(baseUrl, id, item, cmdTimeout)));
    }
  }
  return data;
}

// Send request
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

    // 大结果由 extension 端自动 stash 并返回 chunked descriptor;
    // 这里透明地把完整内容拉回来，调用方看不到 chunking 细节。
    const resolved = await autoResolveChunked(baseUrl, id, data.data, timeout);

    // Format output
    await formatOutput(action, resolved);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.code === 'ABORT_ERR') {
      console.error(`Timeout: No response within ${timeout}ms. Is the browser bubble connected?`);
    } else if (err.cause?.code === 'ECONNREFUSED') {
      console.error(`Connection refused: Cockpit server not running at ${baseUrl}`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
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

// Export promise for external await
export const done = run();
