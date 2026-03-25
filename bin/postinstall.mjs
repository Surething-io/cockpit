#!/usr/bin/env node

import { accessSync, cpSync, existsSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

if (process.platform !== 'win32') {
  // node-pty: spawn-helper 需要可执行权限
  try {
    const spawnHelper = join(
      projectRoot,
      `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    );
    accessSync(spawnHelper);
    execSync(`chmod +x "${spawnHelper}"`);
  } catch {}
}

// chrome-extension → ~/.cockpit/chrome-extension/
// npm 安装时 projectRoot 在 node_modules 下（无 src/ 目录），需要复制到用户目录
// npm link 时 projectRoot 是源码目录（有 src/），不需要复制
const isNpmInstall = !existsSync(join(projectRoot, 'src'));
if (isNpmInstall) {
  try {
    const src = join(projectRoot, 'chrome-extension');
    const dest = join(homedir(), '.cockpit', 'chrome-extension');
    accessSync(src);
    mkdirSync(join(homedir(), '.cockpit'), { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });
    // macOS: 清除 com.apple.provenance 等扩展属性
    if (process.platform === 'darwin') {
      try { execSync(`xattr -cr "${dest}"`); } catch {}
    }
  } catch {}
}
