#!/usr/bin/env node

/**
 * cock-dev — 开发环境入口
 *
 * cock-dev                           → 直接启动 dev server（不 build，有 HMR）
 * cock-dev browser <id> <action>     → 连接 localhost:3456
 * cock-dev terminal <id> <action>    → 连接 localhost:3456
 */

process.env.COCKPIT_ENV = 'dev';
process.env.COCKPIT_PORT = '3456';

// 子命令分流
if (process.argv[2] === 'browser') {
  process.argv.splice(2, 1);
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

// Dev server：跳过 build，直接启动（等同 npm run dev）
import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

console.log('Starting Cockpit (dev)...');
spawnSync('node', ['--import', 'tsx', 'server.mjs'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
