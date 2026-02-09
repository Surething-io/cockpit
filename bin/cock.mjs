#!/usr/bin/env node

import { dirname, resolve } from 'path';
import { fileURLToPath } from 'url';
import { execSync, spawnSync } from 'child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const PROJECT_ROOT = resolve(__dirname, '..');

// Build
console.log('Building...');
execSync('npm run build', { cwd: PROJECT_ROOT, stdio: 'inherit' });

// Start (foreground, Ctrl+C to stop)
console.log('Starting Cockpit...');
spawnSync('npm', ['run', 'start'], { cwd: PROJECT_ROOT, stdio: 'inherit' });
