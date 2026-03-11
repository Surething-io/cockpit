#!/usr/bin/env node

import { cpSync, mkdirSync, accessSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// node-pty permission fix (macOS)
try {
  const spawnHelper = join(projectRoot, 'node_modules/node-pty/prebuilds/darwin-arm64/spawn-helper');
  accessSync(spawnHelper);
  execSync(`chmod +x "${spawnHelper}"`);
} catch {}

// Copy chrome extension to user home
try {
  const srcManifest = join(projectRoot, 'chrome-extension', 'manifest.json');
  accessSync(srcManifest);

  // $HOME is preserved by sudo, os.homedir() returns root's home under sudo
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) throw new Error('Cannot determine home directory');

  const cockpitDir = join(home, '.cockpit');
  const targetDir = join(cockpitDir, 'chrome-extension');

  mkdirSync(cockpitDir, { recursive: true });
  cpSync(join(projectRoot, 'chrome-extension'), targetDir, { recursive: true });

  // Fix ownership if running as sudo (files created by root need to be owned by real user)
  if (process.env.SUDO_USER) {
    execSync(`chown -R "${process.env.SUDO_USER}" "${cockpitDir}"`);
  }

  console.log('Chrome extension installed to ~/.cockpit/chrome-extension');
} catch {}
