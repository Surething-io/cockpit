// PTY host: owns every terminal bubble — PTY and pipe mode — so they outlive a
// server restart.
//
// Why a separate process: a PTY's controlling side (the master fd) belongs to
// whoever spawned it. When that was the cockpit server, every update/restart
// took all running terminals down with it — the server kills its children on
// exit, and even a surviving child gets SIGHUP the moment the master closes.
// Here the server is only a client over a local socket; it can come and go and
// the shells keep running. On reconnect it gets each session back together
// with the output it missed.
//
// SELF-CONTAINED BY REQUIREMENT — Node builtins + node-pty only. Like
// updater.mjs this runs from a staged copy under <cockpitHome>/pty-host/, never
// from the install directory: `npm i -g` replaces that directory while we are
// alive, and on Windows node-pty's loaded .node files would lock it and make
// the install fail outright.
//
// Two modes:
//   --launch  Run from the install dir by the server. Stages this script and
//             node-pty into --dir, spawns the staged copy with --serve fully
//             detached, and exits at once. Exiting is the point: the real host
//             is then nobody's child, so the server's exit-time child cleanup
//             (`pkill -P <server>` / its Windows equivalent) cannot reach it.
//   --serve   The host itself.
//
// Protocol: newline-delimited JSON over a unix socket (named pipe on Windows).
// No compatibility is kept across host code changes: `hello` reports BUILD (a
// hash of this file), and a server whose bin/pty-host.mjs hashes differently
// shuts this host down and launches its own — the sessions here end with it.
// Changes that leave this file untouched keep terminals alive across updates.
//
//   client -> host                       host -> client
//   hello                                hello {proto, build, pid, sessions[]}
//   spawn {id,kind,file,args,cwd,env,..} spawned {id,pid} | spawnError {id,error}
//   write {id,data}                      data {id,data,stream?}
//   eof {id}       close a pipe's stdin  exit {id,exitCode,signal}
//   resize {id,cols,rows}
//   kill {id,signal?}
//   ack {id}       drop an exited session (the server has persisted it)
//   shutdown       kill everything and exit (`cockpit stop`)
//
// kind is 'pty' (default) or 'pipe'. A pipe command is a plain child with
// separate stdout/stderr (`stream` on its data events) and no TTY.
import { spawn } from 'child_process';
import { createHash } from 'crypto';
import { appendFileSync, cpSync, existsSync, mkdirSync, openSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'fs';
import { createServer, connect } from 'net';
import { createRequire } from 'module';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const PROTOCOL = 1;
/** Identifies this exact host code; must match hostBuildId() in ptyHostClient.ts. */
const BUILD = createHash('sha1').update(readFileSync(fileURLToPath(import.meta.url))).digest('hex').slice(0, 12);
/** Per-session replay buffer while no server is watching (matches the server's ring). */
const RING_MAX = 2 * 1024 * 1024;
/** Exit this long after the last client left, provided no session remains. */
const IDLE_EXIT_MS = 10_000;

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}

const socketPath = arg('socket');
const stageDir = arg('dir');
const title = arg('title', 'cockpit-pty');
const logPath = arg('log');

if (!socketPath || !stageDir) {
  console.error('pty-host: --socket and --dir are required');
  process.exit(2);
}

function log(line) {
  const stamped = `[${new Date().toISOString()}] [pty-host ${process.pid}] ${line}\n`;
  if (!logPath) return;
  try { appendFileSync(logPath, stamped); } catch { /* logging must never kill the host */ }
}

// ─────────────────────────────────────────────────────────
// --launch
// ─────────────────────────────────────────────────────────

/**
 * Copy node-pty's runtime files next to the staged script.
 *
 * Only what loads at runtime — lib/, package.json and the native binaries for
 * this platform (a local build/Release wins over prebuilds, same order
 * node-pty's own loader uses). The full package is ~60MB of sources and other
 * platforms' prebuilds. Skipped when the stamp says the same node-pty was
 * already staged from the same place; node-pty uses N-API, so a Node upgrade
 * does not invalidate the binaries.
 */
function stageNodePty() {
  const require = createRequire(import.meta.url);
  const src = dirname(require.resolve('node-pty/package.json'));
  const dest = join(stageDir, 'node_modules', 'node-pty');
  const version = JSON.parse(readFileSync(join(src, 'package.json'), 'utf8')).version;
  const stamp = `${version}\n${src}\n${process.platform}-${process.arch}\n`;
  const stampPath = join(stageDir, 'node-pty.stamp');
  try {
    if (readFileSync(stampPath, 'utf8') === stamp && existsSync(join(dest, 'package.json'))) return;
  } catch { /* no stamp yet */ }

  rmSync(dest, { recursive: true, force: true });
  mkdirSync(dest, { recursive: true });
  cpSync(join(src, 'package.json'), join(dest, 'package.json'));
  cpSync(join(src, 'lib'), join(dest, 'lib'), { recursive: true });
  const built = join(src, 'build', 'Release');
  const prebuilt = join(src, 'prebuilds', `${process.platform}-${process.arch}`);
  if (existsSync(built)) cpSync(built, join(dest, 'build', 'Release'), { recursive: true });
  if (existsSync(prebuilt)) cpSync(prebuilt, join(dest, 'prebuilds', `${process.platform}-${process.arch}`), { recursive: true });
  writeFileSync(stampPath, stamp);
}

function launch() {
  mkdirSync(stageDir, { recursive: true });
  if (logPath) mkdirSync(dirname(logPath), { recursive: true });
  const staged = join(stageDir, 'pty-host.mjs');
  try {
    stageNodePty();
    cpSync(fileURLToPath(import.meta.url), staged);
  } catch (e) {
    // A previous host from this same protocol can still be exiting and, on
    // Windows, holding these files. If a staged copy exists it is compatible
    // by definition (same PROTOCOL directory), so run that.
    if (!existsSync(staged)) {
      log(`launch: staging failed: ${e.message}`);
      process.exit(1);
    }
    log(`launch: staging failed, reusing existing copy: ${e.message}`);
  }

  const out = logPath ? openSync(logPath, 'a') : 'ignore';
  const child = spawn(
    process.execPath,
    [staged, '--serve', '--socket', socketPath, '--dir', stageDir, '--title', title, ...(logPath ? ['--log', logPath] : [])],
    {
      // Never the install dir: on Windows a process's cwd blocks that
      // directory from being replaced.
      cwd: stageDir,
      env: process.env,
      // New session on POSIX: no controlling terminal, so a Ctrl-C in the
      // shell that runs `npm run dev` never reaches us.
      detached: true,
      windowsHide: true,
      stdio: ['ignore', out, out],
    },
  );
  child.unref();
  process.exit(0);
}

// ─────────────────────────────────────────────────────────
// --serve
// ─────────────────────────────────────────────────────────

/** Byte-capped replay buffer. Trimming may split an escape sequence; the
 *  server's findSafeStart() already handles that on replay. */
class Ring {
  chunks = [];
  len = 0;
  append(data) {
    this.chunks.push(data);
    this.len += data.length;
    while (this.len > RING_MAX && this.chunks.length > 0) {
      const over = this.len - RING_MAX;
      const head = this.chunks[0];
      if (head.length <= over) {
        this.chunks.shift();
        this.len -= head.length;
      } else {
        this.chunks[0] = head.slice(over);
        this.len -= over;
      }
    }
  }
  snapshot() {
    return this.chunks.join('');
  }
}

async function serve() {
  process.title = title;
  const require = createRequire(import.meta.url);
  const pty = require('node-pty');

  /** id -> { kind, pty | child, pid, meta, ring, exited, exitCode, signal } */
  const sessions = new Map();
  const clients = new Set();
  let idleTimer = null;

  const broadcast = (msg) => {
    const line = JSON.stringify(msg) + '\n';
    for (const c of clients) {
      try { c.write(line); } catch { /* closing */ }
    }
  };

  const scheduleIdleCheck = () => {
    clearTimeout(idleTimer);
    idleTimer = null;
    if (clients.size > 0 || sessions.size > 0) return;
    idleTimer = setTimeout(() => {
      if (clients.size === 0 && sessions.size === 0) {
        log('idle, exiting');
        process.exit(0);
      }
    }, IDLE_EXIT_MS);
  };

  const describe = (id, s) => ({
    id,
    kind: s.kind,
    pid: s.pid,
    meta: s.meta,
    output: s.ring.snapshot(),
    ...(s.exited ? { exited: true, exitCode: s.exitCode, signal: s.signal } : {}),
  });

  const killSession = (s, signal) => {
    if (s.exited) return;
    if (s.kind === 'pty') {
      try { s.pty.kill(signal); } catch { /* gone */ }
      return;
    }
    // Pipe children run in their own process group (detached), so take the
    // whole group — a `--login -c` shell's grandchildren included.
    try {
      if (process.platform === 'win32') throw new Error('no process groups');
      process.kill(-s.pid, signal || 'SIGTERM');
    } catch {
      try { s.child.kill(signal || 'SIGTERM'); } catch { /* gone */ }
    }
  };

  /** Record the exit once, and tell whoever is connected. */
  const finish = (id, entry, exitCode, signal) => {
    if (entry.exited) return;
    entry.exited = true;
    entry.exitCode = exitCode;
    entry.signal = signal;
    // Kept until a server acks it: if none is connected right now, the next
    // one learns the exit code from `hello` and persists it.
    broadcast({ ev: 'exit', id, exitCode, signal });
  };

  const spawnPty = (msg) => {
    const p = pty.spawn(msg.file, msg.args, {
      name: 'xterm-256color',
      cols: msg.cols || 120,
      rows: msg.rows || 30,
      cwd: msg.cwd,
      env: msg.env,
    });
    const entry = { kind: 'pty', pty: p, pid: p.pid, meta: msg.meta ?? null, ring: new Ring(), exited: false };
    p.onData((data) => {
      entry.ring.append(data);
      broadcast({ ev: 'data', id: msg.id, data });
    });
    p.onExit(({ exitCode, signal }) => finish(msg.id, entry, exitCode, signal));
    return entry;
  };

  const spawnPipe = (msg) => {
    const child = spawn(msg.file, msg.args, {
      cwd: msg.cwd,
      env: msg.env,
      stdio: ['pipe', 'pipe', 'pipe'],
      // Own process group: Ctrl-C from the bubble signals the group.
      detached: true,
      windowsHide: true,
    });
    if (!child.pid) {
      // Launch failures (ENOENT, bad cwd) report through a later 'error'.
      child.on('error', () => {});
      throw new Error('Failed to spawn process');
    }
    const entry = { kind: 'pipe', child, pid: child.pid, meta: msg.meta ?? null, ring: new Ring(), exited: false };
    const onData = (stream) => (buf) => {
      const data = buf.toString();
      entry.ring.append(data);
      broadcast({ ev: 'data', id: msg.id, data, stream });
    };
    child.stdout.on('data', onData('stdout'));
    child.stderr.on('data', onData('stderr'));
    // Writing after the child closed its stdin raises EPIPE here, not at the caller.
    child.stdin.on('error', () => {});
    child.on('close', (code, signal) => finish(msg.id, entry, code, signal));
    child.on('error', () => finish(msg.id, entry, 1, null));
    return entry;
  };

  const handle = (sock, msg) => {
    const reply = (m) => { try { sock.write(JSON.stringify(m) + '\n'); } catch { /* gone */ } };
    const s = msg.id !== undefined ? sessions.get(msg.id) : undefined;
    switch (msg.op) {
      case 'hello':
        reply({ ev: 'hello', proto: PROTOCOL, build: BUILD, pid: process.pid, sessions: [...sessions].map(([id, x]) => describe(id, x)) });
        return;
      case 'spawn': {
        if (sessions.has(msg.id)) {
          // A rerun reuses the command id. The previous run must have exited
          // (the UI only reruns finished bubbles); if it somehow has not, the
          // new session replaces it and the old one is killed, so the two can
          // never interleave output under one id.
          killSession(sessions.get(msg.id));
          sessions.delete(msg.id);
        }
        let entry;
        try {
          entry = msg.kind === 'pipe' ? spawnPipe(msg) : spawnPty(msg);
        } catch (e) {
          reply({ ev: 'spawnError', id: msg.id, error: e.message });
          return;
        }
        sessions.set(msg.id, entry);
        log(`spawn id=${msg.id} kind=${entry.kind} pid=${entry.pid} file=${msg.file}`);
        reply({ ev: 'spawned', id: msg.id, pid: entry.pid });
        clearTimeout(idleTimer);
        return;
      }
      case 'write':
        if (!s || s.exited) return;
        try {
          if (s.kind === 'pty') s.pty.write(msg.data);
          else if (s.child.stdin.writable) s.child.stdin.write(msg.data);
        } catch { /* exited */ }
        return;
      case 'eof':
        if (s && !s.exited && s.kind === 'pipe') { try { s.child.stdin.end(); } catch { /* closed */ } }
        return;
      case 'resize':
        if (s && !s.exited && s.kind === 'pty') { try { s.pty.resize(msg.cols, msg.rows); } catch { /* exited */ } }
        return;
      case 'kill':
        if (s) killSession(s, msg.signal);
        return;
      case 'ack':
        if (s?.exited) {
          sessions.delete(msg.id);
          scheduleIdleCheck();
        }
        return;
      case 'shutdown':
        log(`shutdown requested, killing ${sessions.size} session(s)`);
        for (const x of sessions.values()) killSession(x);
        // Give the SIGHUPs a moment to land before our own exit.
        setTimeout(() => process.exit(0), 300);
        return;
    }
  };

  const server = createServer((sock) => {
    clients.add(sock);
    clearTimeout(idleTimer);
    sock.setEncoding('utf8');
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk;
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { continue; }
        handle(sock, msg);
      }
    });
    const drop = () => {
      if (!clients.delete(sock)) return;
      scheduleIdleCheck();
    };
    sock.on('close', drop);
    sock.on('error', drop);
  });

  // Exactly one host per socket. A live one answers a connect; a stale socket
  // file left by a crashed host does not, and is removed before we listen.
  if (process.platform !== 'win32' && existsSync(socketPath)) {
    const alive = await new Promise((resolve) => {
      const probe = connect(socketPath);
      probe.once('connect', () => { probe.destroy(); resolve(true); });
      probe.once('error', () => resolve(false));
    });
    if (alive) {
      log('another host already owns the socket, exiting');
      process.exit(0);
    }
    try { unlinkSync(socketPath); } catch { /* raced with its owner */ }
  }

  server.on('error', (e) => {
    log(`listen failed: ${e.message}`);
    process.exit(1);
  });
  let listening = false;
  server.listen(socketPath, () => {
    listening = true;
    log(`listening on ${socketPath} (build ${BUILD})`);
    scheduleIdleCheck();
  });

  // Detached, so these only arrive when someone targets us on purpose. SIGHUP
  // is the exception worth ignoring: nothing we own should hang up with a
  // terminal we were never attached to.
  process.on('SIGHUP', () => {});
  process.on('uncaughtException', (e) => log(`uncaughtException: ${e?.stack || e}`));
  process.on('exit', () => {
    // Only a host that actually bound the socket may remove it — one that lost
    // the race above would otherwise delete the winner's.
    if (listening && process.platform !== 'win32') { try { unlinkSync(socketPath); } catch { /* gone */ } }
  });
}

if (process.argv.includes('--launch')) launch();
else if (process.argv.includes('--serve')) await serve();
else {
  console.error('pty-host: pass --launch or --serve');
  process.exit(2);
}
