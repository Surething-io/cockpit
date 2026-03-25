#!/usr/bin/env node

import { accessSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

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

  // chrome-extension: sudo 安装时目录权限可能是 700，Chrome 无法读取
  // 设为 755/644 让当前用户的 Chrome 能加载 unpacked extension
  try {
    const extDir = join(projectRoot, 'chrome-extension');
    accessSync(extDir);
    execSync(`chmod -R a+rX "${extDir}"`);
  } catch {}
}
