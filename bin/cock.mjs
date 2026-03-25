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
  update                       Update to latest version

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
if (process.argv[2] === 'browser') {
  // cock browser <id> <action> [args...] → delegate to cock-browser.mjs
  process.argv.splice(2, 1); // Remove 'browser' so cock-browser.mjs parses from argv[2]
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

// Start (foreground, Ctrl+C to stop)
const isDev = process.env.COCKPIT_ENV === 'dev';
const { existsSync } = await import('fs');
// prod mode requires a pre-built artifact; dev mode is compiled on-the-fly by Next.js
if (!isDev && !existsSync(resolve(PROJECT_ROOT, '.next-prod', 'BUILD_ID'))) {
  console.error('No production build found.\n');
  console.error('Run: npm run build');
  process.exit(1);
}

console.log('Starting Cockpit...');
// dev: tsx for on-the-fly TS compilation; prod: pre-compiled dist/
const args = isDev ? ['--import', 'tsx', 'server.mjs'] : ['server.mjs'];
spawnSync('node', args, { cwd: PROJECT_ROOT, stdio: 'inherit' });
