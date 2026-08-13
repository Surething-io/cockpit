import { createServer } from 'http';
import { createGzip, constants as zlibConstants } from 'zlib';
import { exec, execSync } from 'child_process';
import { networkInterfaces, homedir } from 'os';
import { writeFileSync, mkdirSync, readFileSync, realpathSync, unlinkSync } from 'fs';
import { join, dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import next from 'next';
import { rotateIfLarge } from './bin/rotateLog.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
process.env.COCKPIT_ROOT = __dirname;

const dev = process.env.COCKPIT_ENV === 'dev';
const port = parseInt(process.env.PORT || (dev ? '3456' : '3457'), 10);

process.title = dev ? 'cockpit-dev' : 'cockpit';
process.env.COCKPIT_PORT = String(port);

// Data dir (COCKPIT_HOME-aware) — single source for the instance lock + server.json.
const cockpitHome = process.env.COCKPIT_HOME
  ? resolve(process.env.COCKPIT_HOME.replace(/^~(?=$|\/)/, homedir()))
  : join(homedir(), '.cockpit');

// Normalize a data-dir path for comparison (resolve symlinks) so a symlinked COCKPIT_HOME
// doesn't read as a different home and defeat the single-instance guard. Falls back to the raw
// path if it doesn't exist yet.
const normHome = (p) => { try { return realpathSync(p); } catch { return p; } };

const SERVER_JSON = join(cockpitHome, 'server.json');

// Read once at boot. `version` backs `cockpit status` (process.env
// npm_package_version is only set when launched through an npm script, so it is
// null under `node server.mjs` / a service unit). `buildId` identifies the
// frontend assets this process serves — a browser tab left open across an
// upgrade still references the previous build's content-hashed chunks, which no
// longer exist on disk.
function readBuildInfo() {
  let version = null;
  try {
    version = JSON.parse(readFileSync(join(__dirname, 'package.json'), 'utf8')).version;
  } catch { /* unreadable package.json — report null rather than fail boot */ }
  let buildId = null;
  try {
    buildId = readFileSync(join(__dirname, '.next-prod', 'BUILD_ID'), 'utf8').trim();
  } catch { /* dev mode has no prebuilt BUILD_ID */ }
  return { version, buildId };
}
const buildInfo = readBuildInfo();
// Expose to the app layer. /api/health used to report
// process.env.npm_package_version, which npm only sets when the process was
// launched through an npm script — under `node server.mjs`, a service unit, or
// the global bin it was always null, so the health probe's version field was
// dead weight.
if (buildInfo.version) process.env.COCKPIT_VERSION = buildInfo.version;
if (buildInfo.buildId) process.env.COCKPIT_BUILD_ID = buildInfo.buildId;

// Single-instance-per-data-dir guard. Probe the recorded instance's /api/health: if a live
// cockpit on THIS data dir answers (app === 'cockpit' && home === this data dir), refuse and
// point the user at COCKPIT_HOME. Connection refused / timeout / wrong signature → stale → take
// over. COCKPIT_FORCE=1 bypasses. (The OS already prevents two binds on one port; this guards
// the case of two instances on different ports sharing one data dir → would double-fire tasks.)
async function ensureSingleInstance() {
  if (process.env.COCKPIT_FORCE) return;
  let prev;
  try { prev = JSON.parse(readFileSync(SERVER_JSON, 'utf8')); } catch { return; }
  if (!prev || !prev.port) return;
  try {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 800);
    const res = await fetch(`http://127.0.0.1:${prev.port}/api/health`, { signal: ac.signal }).finally(() => clearTimeout(timer));
    if (!res.ok) return; // not a healthy cockpit → stale, proceed
    const body = await res.json().catch(() => ({}));
    if (body.app === 'cockpit' && normHome(body.home) === normHome(cockpitHome)) {
      console.error(`\n✗ This data dir already has a running cockpit (pid ${body.pid}, port ${body.port}).`);
      console.error(`  Data dir: ${cockpitHome}`);
      console.error(`  To run a second instance, isolate it with COCKPIT_HOME, e.g.:`);
      console.error(`    COCKPIT_HOME=~/.cockpit-alt cockpit`);
      console.error(`  False alarm? Delete ${SERVER_JSON} or set COCKPIT_FORCE=1.\n`);
      process.exit(1);
    }
  } catch { /* connection refused / timeout / non-cockpit → stale, proceed */ }
}

// ============================================
// Process lifecycle guards
//
// 1) When the parent process dies, the stdout/stderr pipes break. Next.js's
//    uncaughtException handler then tries to console.log the error → writes
//    to stdout → EPIPE → triggers the handler again → CPU spin loop.
//    Intercept pipe errors before they escalate to uncaughtException and
//    exit immediately.
//
// 2) In dev mode Next.js runs a `next-server` worker (turbopack) in its own
//    child process. If the parent is killed abnormally (npm reinstall,
//    Ctrl+C through an npm wrapper, IDE killing the task, etc.), the
//    next-server child doesn't die with it — having lost its parent it
//    **re-binds to Next's default port 3000** and then wedges every later
//    `npm run dev` (Next detects "a dev server is already running" via
//    .next/dev/logs and refuses to start). So the parent must explicitly
//    kill all direct children before exiting.
// ============================================
// Assigned once the server-side bundle is loaded (see app.prepare below). Lets the
// synchronous exit hook flush live PTY scrollback to disk so a graceful restart
// (Ctrl-C / SIGINT / SIGTERM) keeps terminal bubbles' content. null until ready.
let flushRunningSync = null;

let _cleanupRan = false;

/**
 * A child that must OUTLIVE us, registered on globalThis by /api/update.
 *
 * The updater is spawned by this process and then has to keep running after we
 * exit — it is what reinstalls the package and starts the replacement server.
 * `detached: true` is not enough: it moves the child into its own session and
 * process group but leaves the parent/child relationship intact, so the
 * `pkill -P <us>` below still matches it. Without this exclusion the server
 * kills the very process that was supposed to bring it back, and the update
 * stops dead with the server down.
 *
 * Read through globalThis because the route lives in Next's module graph and
 * cannot import this file.
 */
function handedOffPid() {
  const pid = globalThis.__cockpitHandedOffPid;
  return typeof pid === 'number' && pid > 0 ? pid : null;
}

function killChildren() {
  if (_cleanupRan) return;
  _cleanupRan = true;
  const spare = handedOffPid();
  if (process.platform === 'win32') {
    // Windows: list child PIDs, then taskkill /F /T each one — running /T on
    // ourselves would take this process down too.
    //
    // This used to shell out to `wmic`, which is deprecated and absent by
    // default from Windows 11 24H2; the failure was swallowed by the catch, so
    // orphaned next-server workers were left running. PowerShell's CIM cmdlet
    // is the supported replacement.
    try {
      const out = execSync(
        `powershell -NoProfile -NonInteractive -Command "Get-CimInstance Win32_Process -Filter 'ParentProcessId=${process.pid}' | Select-Object -ExpandProperty ProcessId"`,
        { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 5000 }
      );
      const pids = out.split(/\r?\n/).map(s => s.trim()).filter(s => /^\d+$/.test(s));
      for (const pid of pids) {
        if (spare && Number(pid) === spare) continue;
        try { execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' }); } catch {}
      }
    } catch {}
    return;
  }
  // POSIX: direct children only, no recursion (next-server and friends are all
  // direct children — enough).
  if (spare) {
    // Enumerate and signal individually so the handed-off updater can be
    // skipped; `pkill -P` has no exclusion form.
    try {
      const out = execSync(`pgrep -P ${process.pid}`, { encoding: 'utf-8', stdio: ['ignore', 'pipe', 'ignore'] });
      for (const line of out.split('\n')) {
        const pid = Number(line.trim());
        if (!pid || pid === spare) continue;
        try { process.kill(pid, 'SIGTERM'); } catch {}
      }
    } catch { /* pgrep exits 1 when there are no children */ }
    return;
  }
  // pkill exits 1 when nothing matches; not treated as an error.
  try { execSync(`pkill -TERM -P ${process.pid}`, { stdio: 'ignore' }); } catch {}
}

// Normal exit path (including every process.exit() call) — Node guarantees
// this handler runs synchronously. All signal/exception paths ultimately go
// through process.exit() → 'exit' fires → this single hook covers every
// graceful shutdown. Flush live PTY scrollback to disk first, then kill the
// children (the flush reads this process's own memory — independent of them).
// Best-effort: drop our server.json on the way out so `cockpit status` says
// "not running" straight away instead of probing a dead port. Guarded by pid so
// we never delete a record a newer instance has since written. A hard kill
// (SIGKILL) skips this entirely — which is why status probes /api/health rather
// than trusting the file's existence.
function removeServerJson() {
  try {
    const rec = JSON.parse(readFileSync(SERVER_JSON, 'utf8'));
    if (rec && rec.pid === process.pid) unlinkSync(SERVER_JSON);
  } catch { /* absent, unreadable, or not ours */ }
}

process.on('exit', () => {
  try { flushRunningSync?.(); } catch {}
  removeServerJson();
  killChildren();
});

// Signal paths — kill children first, then exit with the code the shell expects
const cleanupAndExit = (code) => () => { killChildren(); process.exit(code); };
process.on('SIGINT',  cleanupAndExit(130));
process.on('SIGTERM', cleanupAndExit(143));
process.on('SIGQUIT', cleanupAndExit(131));
process.on('SIGHUP',  cleanupAndExit(0));

// Uncaught exceptions — don't let Next.js's default handler console.log its
// way back into the EPIPE spin loop
process.on('uncaughtException', (err) => {
  try { console.error('uncaughtException:', err); } catch {}
  killChildren();
  process.exit(1);
});

// Broken stdout/stderr pipe → exit immediately (the exit handler cleans up
// the children on the way out)
process.stdout.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
});
process.stderr.on('error', (err) => {
  if (err.code === 'EPIPE' || err.code === 'ERR_STREAM_DESTROYED') process.exit(0);
});

// Fail-fast guard against Next build/runtime version skew. The published
// package ships a prebuilt `.next-prod` and loads Next's server runtime from
// node_modules at runtime; if a floating range ever lets those diverge, the
// React server renderer breaks on EVERY request with a cryptic
// "renderToPipeableStream is not implemented" and the whole app 500s. `next`
// is pinned to an exact version in package.json to prevent this, but a bad
// global install / manual tampering could still drift it — so cross-check the
// build stamp (written by scripts/stamp-build.mjs) against the installed Next
// and refuse to start with an actionable message rather than serving garbage.
function assertNextVersionMatchesBuild() {
  if (dev) return; // dev has no prebuilt .next-prod
  let built;
  try {
    built = JSON.parse(readFileSync(join(__dirname, '.next-prod', 'cockpit-build.json'), 'utf8')).next;
  } catch {
    return; // older build without a stamp — skip (backward compatible)
  }
  let installed;
  try {
    installed = JSON.parse(readFileSync(join(__dirname, 'node_modules', 'next', 'package.json'), 'utf8')).version;
  } catch {
    return; // can't resolve installed Next — let Next itself report the problem
  }
  if (built !== installed) {
    console.error(`\n✗ Next.js version mismatch — this build cannot run on the installed Next.`);
    console.error(`  Built with:  next@${built}`);
    console.error(`  Installed:   next@${installed}`);
    console.error(`  The shipped .next-prod is compiled for an exact Next version. A newer/older`);
    console.error(`  runtime breaks server rendering (every request 500s).`);
    console.error(`  Fix: reinstall so the exact version is used —`);
    console.error(`    npm install -g @surething/cockpit@latest\n`);
    process.exit(1);
  }
}
assertNextVersionMatchesBuild();

const app = next({ dev });
const handle = app.getRequestHandler();

app.prepare().then(async () => {
  await ensureSingleInstance();

  // Rotate the app log — AFTER the single-instance check, never before. A
  // second `cockpit` on the same data dir is rejected above, and if it had
  // rotated first it would have consumed a generation of a *running*
  // instance's history just by failing to start.
  //
  // Safe to do here because the Effect logger appends per write (fs/promises
  // appendFile) rather than holding an fd, so nothing has the file open and it
  // recreates it on the next line. This is also what makes it work on Windows,
  // where renaming a file that some process holds open fails outright.
  rotateIfLarge(join(cockpitHome, 'logs', 'cockpit.log'));
  const upgradeHandler = app.getUpgradeHandler();
  // v2 P8: HTTP intercepts (handleTerminalApi / handleBrowserApi) moved to src/lib/httpApi.ts
  const { handleUpgrade, broadcastToGlobalState } = await import(dev ? './src/lib/wsServer.ts' : './dist/wsServer.mjs');
  const auth = await import(dev ? './src/lib/auth.ts' : './dist/auth.mjs');
  const httpApi = await import(dev ? './src/lib/httpApi.ts' : './dist/httpApi.mjs');
  const { handleBrowserApi, handleTerminalApi, handleConnectionApi } = httpApi;
  flushRunningSync = httpApi.flushAllRunningSync || null;
  const { scheduledTaskManager } = await import(dev ? '@cockpit/feature-agent/server/scheduledTasks' : './dist/scheduledTasks.mjs');

  // Initialize the scheduled-task manager
  scheduledTaskManager.setOnTaskFired((task) => {
    broadcastToGlobalState({ type: 'task-fired', taskId: task.id, cwd: task.cwd, tabId: task.tabId, sessionId: task.sessionId });
  });
  await scheduledTaskManager.init();

  // ============================================
  // Token gate — opt-in via `cockpit --token <value>` (COCKPIT_TOKEN).
  // Off by default (open). Local callers (loopback peer + no forwarding header)
  // are exempt, so the CLI / /cg curls / self-probe never need a token.
  // ============================================
  const gateInput = (req, isWs) => ({
    url: req.url || '',
    remoteAddr: req.socket?.remoteAddress,
    cookieHeader: req.headers?.cookie,
    authHeader: req.headers?.authorization,
    forwarded:
      req.headers?.['x-forwarded-for'] ||
      req.headers?.['x-real-ip'] ||
      req.headers?.['forwarded'],
    isWs,
    isHttps:
      String(req.headers?.['x-forwarded-proto'] || '').split(',')[0].trim() === 'https',
  });

  // Apply the gate to an HTTP request. Returns true if it wrote a response
  // (blocked / redirected) and the caller should stop.
  const applyHttpGate = (req, res) => {
    const decision = auth.checkAccess(gateInput(req, false));
    if (decision.action === 'redirect') {
      res.writeHead(302, { Location: decision.location, 'Set-Cookie': decision.setCookie });
      res.end();
      return true;
    }
    if (decision.action === 'deny') {
      res.writeHead(401, { 'Content-Type': 'text/plain; charset=utf-8' });
      res.end('401 Unauthorized - append ?token=<token> to the URL to authenticate\n');
      return true;
    }
    return false;
  };

  // ============================================
  // Local-admin marker — stamp an internal, client-UNFORGEABLE header telling
  // the app layer whether this request comes from a trusted LOCAL peer (loopback
  // socket + no forwarding header), the same "local exempt" notion checkAccess()
  // uses. Review viewing of a CLOSED review is revoked for everyone except the
  // local admin; the app can't see the TCP peer, so we decide it here.
  //
  // We ALWAYS overwrite any inbound x-cockpit-local first: without this a remote
  // client could send the header and impersonate a local admin. Mirrors the
  // share server's x-forwarded-for injection discipline.
  // ============================================
  const LOCAL_HEADER = 'x-cockpit-local';
  const markLocalRequest = (req) => {
    const gi = gateInput(req, false);
    const isLocal = !gi.forwarded && auth.isLoopbackAddr(gi.remoteAddr);
    req.headers[LOCAL_HEADER] = isLocal ? '1' : '0';
  };

  // ============================================
  // /api/* JSON gzip — Next's built-in compression only runs under
  // `next start`; with this custom server, API JSON goes out uncompressed
  // (fine locally at <10ms, but behind a tunnel like ngrok a 200KB+
  // session-by-path response means seconds of latency). Transparently wrap
  // application/json responses in gzip; SSE / HTML / static assets (which
  // Next already compresses) are untouched.
  // ============================================
  const gzipJsonResponse = (req, res) => {
    if (!/\bgzip\b/i.test(String(req.headers['accept-encoding'] || ''))) return;
    const origWriteHead = res.writeHead.bind(res);
    const origWrite = res.write.bind(res);
    const origEnd = res.end.bind(res);
    let gzip = null;
    let decided = false;

    // Decide at first output (writeHead/write/end): only compress JSON that
    // isn't already encoded.
    const decide = () => {
      if (decided) return;
      decided = true;
      const ct = String(res.getHeader('content-type') || '');
      if (!ct.includes('application/json') || res.getHeader('content-encoding')) return;
      res.removeHeader('content-length');
      res.setHeader('content-encoding', 'gzip');
      const vary = String(res.getHeader('vary') || '');
      if (!/\baccept-encoding\b/i.test(vary)) {
        res.setHeader('vary', vary ? `${vary}, Accept-Encoding` : 'Accept-Encoding');
      }
      gzip = createGzip({ flush: zlibConstants.Z_SYNC_FLUSH });
      gzip.on('data', (chunk) => origWrite(chunk));
      gzip.on('end', () => origEnd());
      gzip.on('error', () => { try { origEnd(); } catch {} });
    };

    // writeHead accepts headers in three shapes: object, flat array
    // [k1,v1,k2,v2,...] (what Next uses internally), and nested array
    // [[k,v],...]. Normalize all of them through setHeader before deciding
    // on compression.
    const applyHeaders = (h) => {
      if (!h) return;
      if (Array.isArray(h)) {
        const pairs = Array.isArray(h[0])
          ? h
          : Array.from({ length: h.length >> 1 }, (_, i) => [h[i * 2], h[i * 2 + 1]]);
        for (const [k, v] of pairs) {
          if (k === undefined || v === undefined) continue;
          const key = String(k);
          const prev = res.getHeader(key);
          // Merge duplicate headers (e.g. set-cookie) into an array instead of overwriting
          res.setHeader(key, prev === undefined ? v : [].concat(prev, v));
        }
      } else {
        for (const [k, v] of Object.entries(h)) {
          if (v !== undefined) res.setHeader(k, v);
        }
      }
    };

    res.writeHead = (status, arg2, arg3) => {
      applyHeaders(typeof arg2 === 'object' ? arg2 : arg3);
      decide();
      return typeof arg2 === 'string' ? origWriteHead(status, arg2) : origWriteHead(status);
    };
    res.write = (chunk, ...args) => {
      decide();
      if (gzip) { gzip.write(chunk); return true; }
      return origWrite(chunk, ...args);
    };
    res.end = (chunk, ...args) => {
      decide();
      if (gzip) {
        if (chunk && typeof chunk !== 'function') gzip.write(chunk);
        gzip.end();
        return res;
      }
      return origEnd(chunk, ...args);
    };
  };

  const server = createServer(async (req, res) => {
    if (applyHttpGate(req, res)) return;
    markLocalRequest(req);
    if (req.url?.startsWith('/api/')) gzipJsonResponse(req, res);

    // /api/browser/* must be handled inside the custom server (it shares
    // BrowserBridge memory with the WS side)
    if (req.url?.startsWith('/api/browser/') && req.method === 'POST') {
      const handled = await handleBrowserApi(req, res);
      if (handled) return;
    }
    if (req.url?.startsWith('/api/terminal/') && req.method === 'POST') {
      const handled = await handleTerminalApi(req, res);
      if (handled) return;
    }
    if (req.url?.startsWith('/api/connection/') && req.method === 'POST') {
      const handled = await handleConnectionApi(req, res);
      if (handled) return;
    }
    handle(req, res);
  });

  server.on('upgrade', (req, socket, head) => {
    // Cookie / ?token ride the same-origin upgrade → gate WS too.
    if (auth.checkAccess(gateInput(req, true)).action !== 'pass') {
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    if (!handleUpgrade(req, socket, head)) {
      upgradeHandler(req, socket, head);
    }
  });

  // COCKPIT_HOST: defaults to 127.0.0.1 (local-only); set 0.0.0.0 for cloud
  // sandboxes and similar environments
  const host = process.env.COCKPIT_HOST || '127.0.0.1';
  server.listen(port, host, () => {
    const url = `http://localhost:${port}`;
    console.log(`> Ready on ${url}`);

    // Discoverability: `cockpit start` is the only way to survive closing the
    // terminal (there is no service integration), but nothing else advertises
    // it. Only worth saying when we ARE in the foreground — a backgrounded
    // instance's operator already knows.
    if ((process.env.COCKPIT_MANAGED || 'foreground') === 'foreground') {
      console.log('  Tip: `cockpit start` runs it in the background — then this terminal can be closed.');
    }

    // Write server.json so CLI subcommands can read the port, and so
    // `cockpit status` / `stop` can find and identify this instance.
    try {
      mkdirSync(cockpitHome, { recursive: true });
      writeFileSync(SERVER_JSON, JSON.stringify({
        pid: process.pid,
        port,
        version: buildInfo.version,
        buildId: buildInfo.buildId,
        startedAt: Date.now(),
        // How this process is supervised, set by whoever launched it:
        // 'foreground' (plain `cockpit`), 'bare' (`cockpit start`), or a
        // service manager later on. `cockpit stop` uses it to decide whether
        // stopping also means telling a supervisor not to restart us.
        managed: process.env.COCKPIT_MANAGED || 'foreground',
      }, null, 2));
    } catch {}

    // Auto-open the browser in prod mode (disable with --no-open)
    if (!dev && !process.env.COCKPIT_NO_OPEN) {
      const openProject = process.env.COCKPIT_OPEN_PROJECT;
      const openUrl = openProject ? `${url}/?cwd=${encodeURIComponent(openProject)}` : url;
      const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
      exec(`${cmd} ${openUrl}`);
    }
  });

  // ============================================
  // Share Server — LAN review-sharing service.
  // Route allowlist: only /review/* and its supporting assets are exposed.
  // ============================================
  const sharePort = port + 1000; // dev 3456→4456, prod 3457→4457

  const SHARE_ALLOWED_PREFIXES = ['/review/', '/api/review', '/_next/', '/fonts/', '/icons/'];
  const SHARE_ALLOWED_EXACT = ['/favicon.ico'];

  function isShareAllowed(url) {
    const pathname = url.split('?')[0];
    if (SHARE_ALLOWED_EXACT.includes(pathname)) return true;
    return SHARE_ALLOWED_PREFIXES.some(p => pathname.startsWith(p));
  }

  function getLanIPs() {
    const interfaces = networkInterfaces();
    const ips = [];
    for (const iface of Object.values(interfaces)) {
      for (const alias of iface || []) {
        if (alias.family === 'IPv4' && !alias.internal) {
          ips.push(alias.address);
        }
      }
    }
    return ips;
  }

  const shareServer = createServer((req, res) => {
    // Token gate first (share is also covered). Read the gate BEFORE we inject
    // x-forwarded-for below, so the injection can't fool the local check.
    if (applyHttpGate(req, res)) return;
    if (req.url?.startsWith('/api/')) gzipJsonResponse(req, res);
    if (isShareAllowed(req.url || '')) {
      // The share port is the revocation surface for LAN viewers — never the
      // local admin. Force the marker to '0' (also strips any forged inbound
      // value). The admin uses the main port (localhost) to keep access to a
      // closed review.
      req.headers['x-cockpit-local'] = '0';
      // Inject the client's real IP for /api/review/identify
      const clientIp = req.socket.remoteAddress || '';
      req.headers['x-forwarded-for'] = clientIp;
      handle(req, res);
    } else {
      res.writeHead(403, { 'Content-Type': 'text/plain' });
      res.end('403 Forbidden');
    }
  });

  shareServer.listen(sharePort, '0.0.0.0', () => {
    const lanIPs = getLanIPs();
    if (lanIPs.length > 0) {
      lanIPs.forEach(ip => console.log(`> Share on http://${ip}:${sharePort}`));
    } else {
      console.log(`> Share on http://0.0.0.0:${sharePort}`);
    }
  });

  shareServer.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      console.log(`> Share server port ${sharePort} in use, skipping`);
    } else {
      console.error('Share server error:', err.message);
    }
  });
});
