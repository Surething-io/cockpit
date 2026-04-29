#!/usr/bin/env node

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

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
  update                         Update to latest version

Options:
  --port <port>                  Set server port (default: 3457)
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

if (process.argv[2] === 'update') {
  console.log('Updating @surething/cockpit...');
  const result = spawnSync('npm', ['install', '-g', '@surething/cockpit@latest'], { stdio: 'inherit' });
  if (result.status === 0) {
    const { readFileSync } = await import('fs');
    const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
    console.log(`\nUpdated to v${pkg.version}`);
  }
  process.exit(result.status ?? 1);
}

// ============================================
// Resolve project directory (if provided)
// ============================================
const { existsSync, mkdirSync } = await import('fs');
const { homedir } = await import('os');

const knownCommands = new Set(['browser', 'terminal', 'update', 'help']);
const arg = process.argv[2];
let projectDir = null;

// 第一个参数不是 flag 且不是已知子命令 → 视为目录路径
if (arg && !arg.startsWith('-') && !knownCommands.has(arg)) {
  // 展开 ~ 为 home 目录
  const raw = arg.startsWith('~') ? arg.replace(/^~/, homedir()) : arg;
  projectDir = resolve(raw);
  // 目录不存在则创建
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
  // 服务已运行 → 打开浏览器，立即退出
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

// 传递项目目录给 server.mjs，让它打开正确的 URL
if (projectDir) {
  process.env.COCKPIT_OPEN_PROJECT = projectDir;
}

console.log('Starting Cockpit...');
const args = isDev ? ['--import', 'tsx', 'server.mjs'] : ['server.mjs'];
spawnSync('node', args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
