#!/usr/bin/env node

import { accessSync } from 'fs';
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
