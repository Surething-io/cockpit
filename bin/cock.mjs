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

if (process.argv[2] === 'update') {
  const { readFileSync, createWriteStream, unlinkSync } = await import('fs');
  const https = await import('https');
  const { tmpdir } = await import('os');
  const pkg = JSON.parse(readFileSync(resolve(PROJECT_ROOT, 'package.json'), 'utf8'));
  console.log(`Current: v${pkg.version}`);
  console.log('Checking latest release...\n');

  // 获取最新 release 信息
  const getLatestRelease = () => new Promise((resolve, reject) => {
    https.get('https://api.github.com/repos/Surething-io/cockpit/releases/latest', {
      headers: { 'User-Agent': 'cockpit-cli', Accept: 'application/vnd.github+json' },
    }, (res) => {
      let data = '';
      res.on('data', (chunk) => data += chunk);
      res.on('end', () => {
        try {
          const release = JSON.parse(data);
          const asset = release.assets?.find(a => a.name.endsWith('.tgz'));
          if (asset) resolve({ url: asset.browser_download_url, name: asset.name, tag: release.tag_name });
          else reject(new Error('No tgz found in latest release'));
        } catch (e) { reject(e); }
      });
    }).on('error', reject);
  });

  // 下载文件（跟随重定向）
  const download = (url, dest) => new Promise((resolve, reject) => {
    const file = createWriteStream(dest);
    const get = (u) => {
      https.get(u, { headers: { 'User-Agent': 'cockpit-cli' } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          get(res.headers.location);
          return;
        }
        if (res.statusCode !== 200) { reject(new Error(`Download failed: ${res.statusCode}`)); return; }
        res.pipe(file);
        file.on('finish', () => { file.close(); resolve(); });
      }).on('error', reject);
    };
    get(url);
  });

  try {
    const { url, name, tag } = await getLatestRelease();
    console.log(`Latest: ${tag}`);
    console.log('Downloading...');
    const tgzPath = resolve(tmpdir(), name);
    await download(url, tgzPath);
    console.log('Installing...\n');
    const result = spawnSync('npm', ['install', '-g', tgzPath], { stdio: 'inherit' });
    try { unlinkSync(tgzPath); } catch {}
    if (result.status === 0) {
      console.log(`\nUpdated to ${tag}`);
    } else {
      console.error('\nInstall failed. Try: sudo cock update');
    }
    process.exit(result.status || 0);
  } catch (err) {
    console.error(`Update failed: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[2] === 'terminal') {
  process.argv.splice(2, 1);
  const mod = await import('./cock-terminal.mjs');
  await mod.done;
  process.exit(0);
}

// Start (foreground, Ctrl+C to stop)
// .next/ 由 prepare (npm run build) 预编译，安装后直接启动
const { existsSync } = await import('fs');
if (!existsSync(resolve(PROJECT_ROOT, '.next', 'BUILD_ID'))) {
  console.error('No production build found.\n');
  console.error('Install with:  npm run release');
  console.error('Or build with: npm run build');
  process.exit(1);
}

console.log('Starting Cockpit...');
spawnSync('node', ['--import', 'tsx', 'server.mjs'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
