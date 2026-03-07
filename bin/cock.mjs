#!/usr/bin/env node

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// cock 默认 prod 端口，cock-dev 会预设 COCKPIT_PORT=3456
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

// Build
console.log('Building...');
execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });

// Start (foreground, Ctrl+C to stop)
console.log('Starting Cockpit...');
spawnSync('node', ['--import', 'tsx', 'server.mjs'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
