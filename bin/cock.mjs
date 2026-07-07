#!/usr/bin/env node

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';
import { hasClaudeBinary } from '../scripts/claudeBinary.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// --help / -h
if (process.argv[2] === '--help' || process.argv[2] === '-h' || process.argv[2] === 'help') {
  const { readFileSync } = await import('fs');
  const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
  console.log(`Cockpit v${pkg.version} - One seat. One AI. Everything under control.

Usage: cockpit [path] [options]   (alias: cock)

Commands:
  cockpit                        Start server, open last project
  cockpit .                      Start server, open current directory
  cockpit <path>                 Start server, open specified directory
  browser <id> <action>          Control browser bubbles
  terminal <id> <action>         Control terminal bubbles
  codegraph <subcmd> [...]       Query the project code graph (search/risk/affected/...)
  connection list [--cwd …]      List all bubbles (term + browser) with user-set titles
  update                         Update to latest version

Options:
  --port <port>                  Set server port (default: 3457)
  --token <token>                Require this token for remote access (local stays open)
  --no-open                      Don't open browser after start
  -v, --version                  Show version
  -h, --help                     Show this help

Both \`cockpit\` and the short alias \`cock\` work everywhere.`);
  process.exit(0);
}

// --version / -v
if (process.argv[2] === '--version' || process.argv[2] === '-v') {
  const { readFileSync } = await import('fs');
  const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
  console.log(pkg.version);
  process.exit(0);
}

// --no-open
const noOpenIdx = process.argv.indexOf('--no-open');
if (noOpenIdx !== -1) {
  process.env.COCKPIT_NO_OPEN = '1';
  process.argv.splice(noOpenIdx, 1);
}

// Parse --port argument
const portIdx = process.argv.indexOf('--port');
if (portIdx !== -1 && process.argv[portIdx + 1]) {
  process.env.PORT = process.argv[portIdx + 1];
  process.argv.splice(portIdx, 2);
}

// Parse --token argument → enable shared-token auth (server.mjs reads
// COCKPIT_TOKEN). Off entirely when omitted. Local (loopback) access stays
// exempt; remote access must present the token.
const tokenIdx = process.argv.indexOf('--token');
if (tokenIdx !== -1 && process.argv[tokenIdx + 1] && !process.argv[tokenIdx + 1].startsWith('-')) {
  process.env.COCKPIT_TOKEN = process.argv[tokenIdx + 1];
  process.argv.splice(tokenIdx, 2);
}

// Default prod port
if (!process.env.COCKPIT_PORT) {
  process.env.COCKPIT_PORT = '3457';
}

// Subcommand routing

// Flush stdout/stderr before exit. process.exit() does NOT wait for
// async pipe writes to drain — for large outputs (> 16 KiB Node stream
// highWaterMark) this truncates at exactly 16384 bytes on macOS pipes.
// Without this, an ollama agent capturing our stdout via execAsync
// receives a cleanly cut mid-string blob and then misdiagnoses it as
// "output truncated" (reproduced in sessions 6910d071 & 22727dd4).
async function flushAndExit(code) {
  const drain = (stream) => new Promise((resolve) => {
    if (!stream.writableLength) { resolve(); return; }
    // Writing an empty string returns false iff the stream is backpressured;
    // the callback then fires once the kernel has actually accepted the data.
    stream.write('', 'utf8', () => resolve());
  });
  try { await Promise.all([drain(process.stdout), drain(process.stderr)]); } catch { /* ignore */ }
  process.exit(code);
}

if (process.argv[2] === 'browser') {
  process.argv.splice(2, 1);
  const mod = await import('./cock-browser.mjs');
  await mod.done;
  await flushAndExit(0);
}

if (process.argv[2] === 'terminal') {
  process.argv.splice(2, 1);
  const mod = await import('./cock-terminal.mjs');
  await mod.done;
  await flushAndExit(0);
}

if (process.argv[2] === 'codegraph') {
  process.argv.splice(2, 1);
  const mod = await import('./cock-codegraph.mjs');
  await mod.done;
  await flushAndExit(0);
}

if (process.argv[2] === 'connection') {
  process.argv.splice(2, 1);
  // cock-connection.mjs handles flow + exit itself (single subcmd, simple).
  await import('./cock-connection.mjs');
  // import() resolves when the module finishes top-level await; that script
  // already calls process.exit() on its own paths, so this fallback only
  // fires for the 0-exit happy path that finished normally.
  await flushAndExit(0);
}

if (process.argv[2] === 'update') {
  console.log('Updating @surething/cockpit...');
  const installArgs = ['install', '-g', '@surething/cockpit@latest', '--include=optional'];
  let result = spawnSync('npm', installArgs, { stdio: 'inherit' });

  // An in-place `npm i -g` can drop the SDK's platform-specific native binary
  // (an optional dependency) when the SDK version bumps — see
  // scripts/claudeBinary.mjs. A clean uninstall + reinstall reliably refetches
  // it. Guard here so `cockpit update` never leaves chat silently broken.
  if (result.status === 0 && !hasClaudeBinary()) {
    console.log('Native Claude binary missing after update — reinstalling to repair...');
    spawnSync('npm', ['uninstall', '-g', '@surething/cockpit'], { stdio: 'inherit' });
    result = spawnSync('npm', installArgs, { stdio: 'inherit' });
  }

  if (result.status === 0) {
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
    console.log(`\nUpdated to v${pkg.version}`);
    if (!hasClaudeBinary()) {
      console.error('\nWarning: the native Claude CLI binary is still missing; chat will not work.');
      console.error('Fix manually: npm uninstall -g @surething/cockpit && npm install -g @surething/cockpit');
    }
  }
  process.exit(result.status ?? 1);
}

// ============================================
// Resolve project directory (if provided)
// ============================================
const { existsSync, mkdirSync } = await import('fs');
const { homedir } = await import('os');

const knownCommands = new Set(['browser', 'terminal', 'update', 'help', 'codegraph', 'connection']);
const arg = process.argv[2];
let projectDir = null;

// First arg is neither a flag nor a known subcommand → treat it as a directory path
if (arg && !arg.startsWith('-') && !knownCommands.has(arg)) {
  // Expand ~ to the home directory
  const raw = arg.startsWith('~') ? arg.replace(/^~/, homedir()) : arg;
  projectDir = resolve(raw);
  // Create the directory if it doesn't exist
  if (!existsSync(projectDir)) {
    mkdirSync(projectDir, { recursive: true });
    console.log(`Created ${projectDir}`);
  }
}

// ============================================
// Check if server is already running
// ============================================
const port = process.env.PORT || process.env.COCKPIT_PORT || '3457';

async function isServerRunning() {
  try {
    const res = await fetch(`http://localhost:${port}/api/version`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

const { exec } = await import('child_process');
const running = await isServerRunning();

if (running) {
  // Server already running → open the browser and exit immediately
  const base = `http://localhost:${port}`;
  const url = projectDir ? `${base}/?cwd=${encodeURIComponent(projectDir)}` : base;
  if (!process.env.COCKPIT_NO_OPEN) {
    const cmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
    exec(`${cmd} ${url}`);
  }
  console.log(`Cockpit is already running → ${url}`);
  process.exit(0);
}

// ============================================
// Start server (foreground, Ctrl+C to stop)
// ============================================
const isDev = process.env.COCKPIT_ENV === 'dev';
if (!isDev && !existsSync(resolve(PROJECT_ROOT, '.next-prod', 'BUILD_ID'))) {
  console.error('No production build found.\n');
  console.error('Run: npm run build');
  process.exit(1);
}

// Warn (don't block) if the SDK's native binary is missing — every panel but
// the Claude chat still works, but chat would otherwise fail with a cryptic
// runtime error only once the user sends a message. See scripts/claudeBinary.mjs.
if (!hasClaudeBinary()) {
  console.error('Warning: the native Claude CLI binary is missing; chat may not work.');
  console.error('Fix: npm uninstall -g @surething/cockpit && npm install -g @surething/cockpit\n');
}

// Hand the project directory to server.mjs so it opens the right URL
if (projectDir) {
  process.env.COCKPIT_OPEN_PROJECT = projectDir;
}

console.log('Starting Cockpit...');
const args = isDev ? ['--import', 'tsx', 'server.mjs'] : ['server.mjs'];
spawnSync('node', args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
