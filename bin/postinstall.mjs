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
    const cockpitDir = join(homedir(), '.cockpit');
    const dest = join(cockpitDir, 'chrome-extension');
    accessSync(src);
    mkdirSync(cockpitDir, { recursive: true });
    cpSync(src, dest, { recursive: true, force: true });

    if (process.platform !== 'win32') {
      // sudo 安装时文件 owner 是 root，Chrome 无法写入 _metadata/
      // 用 SUDO_USER 还原为真实用户
      const realUser = process.env.SUDO_USER;
      if (realUser) {
        try { execSync(`chown -R "${realUser}" "${cockpitDir}"`); } catch {}
      }
      // macOS: 清除 com.apple.provenance 等扩展属性
      if (process.platform === 'darwin') {
        try { execSync(`xattr -cr "${dest}"`); } catch {}
      }
    }
  } catch {}

  // jupyter_bridge.py → ~/.cockpit/kernels/jupyter_bridge.py
  try {
    const kernelSrc = join(projectRoot, 'kernels', 'jupyter_bridge.py');
    const cockpitDir = join(homedir(), '.cockpit');
    const kernelDestDir = join(cockpitDir, 'kernels');
    accessSync(kernelSrc);
    mkdirSync(kernelDestDir, { recursive: true });
    cpSync(kernelSrc, join(kernelDestDir, 'jupyter_bridge.py'), { force: true });

    if (process.platform !== 'win32') {
      const realUser = process.env.SUDO_USER;
      if (realUser) {
        try { execSync(`chown -R "${realUser}" "${cockpitDir}"`); } catch {}
      }
      if (process.platform === 'darwin') {
        try { execSync(`xattr -cr "${kernelDestDir}"`); } catch {}
      }
    }
  } catch {}
}
