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

Usage: cock [command]

Commands:
  (default)                    Start Cockpit server (port 3457)
  browser <id> <action>        Control browser bubbles
  terminal <id> <action>       Control terminal bubbles

Options:
  --port <port>                Set server port (default: 3457)
  --no-open                    Don't open browser after start
  -v, --version                Show version
  -h, --help                   Show this help`);
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

// --port 参数解析
const portIdx = process.argv.indexOf('--port');
if (portIdx !== -1 && process.argv[portIdx + 1]) {
  process.env.PORT = process.argv[portIdx + 1];
  process.argv.splice(portIdx, 2);
}

// 默认 prod 端口
if (!process.env.COCKPIT_PORT) {
  process.env.COCKPIT_PORT = '3457';
}

// 子命令分流
if (process.argv[2] === 'browser') {
  // cock browser <id> <action> [args...] → 委托给 cock-browser.mjs
  process.argv.splice(2, 1); // 移除 'browser'，让 cock-browser.mjs 从 argv[2] 开始解析
  const mod = await import('./cock-browser.mjs');
  await mod.done;
  process.exit(0);
}

if (process.argv[2] === 'terminal') {
  process.argv.splice(2, 1);
  const mod = await import('./cock-terminal.mjs');
  await mod.done;
  process.exit(0);
}

// Start (foreground, Ctrl+C to stop)
const isDev = process.env.COCKPIT_ENV === 'dev';
const { existsSync } = await import('fs');
// prod 模式需要预编译产物，dev 模式由 Next.js 即时编译
if (!isDev && !existsSync(resolve(PROJECT_ROOT, '.next-prod', 'BUILD_ID'))) {
  console.error('No production build found.\n');
  console.error('Run: npm run build');
  process.exit(1);
}

console.log('Starting Cockpit...');
spawnSync('node', ['--import', 'tsx', 'server.mjs'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
