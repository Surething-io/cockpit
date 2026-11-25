#!/usr/bin/env node

import { accessSync, cpSync, existsSync, mkdirSync, rmSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { execSync } from 'child_process';
import { homedir } from 'os';
import { copyTreeSitterWasms } from '../scripts/copy-tree-sitter-wasms.mjs';
import { copyPdfjsWorker } from '../scripts/copy-pdfjs-worker.mjs';
import { missingAgentBinaries, prepareGrokBinary } from '../scripts/agentBinaries.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const projectRoot = join(__dirname, '..');

// Tree-sitter WASMs → public/tree-sitter/. Wrapped in try/catch so a
// missing source dir / permission issue doesn't break the rest of
// postinstall (the helper itself is already graceful, but importing
// it can still fail if scripts/ went missing somehow).
try {
  copyTreeSitterWasms(projectRoot);
} catch (err) {
  console.warn('[postinstall] tree-sitter WASM copy failed:', err?.message ?? err);
}

// pdf.js worker → public/pdfjs/. Same graceful contract as above.
try {
  copyPdfjsWorker(projectRoot);
} catch (err) {
  console.warn('[postinstall] pdf.js worker copy failed:', err?.message ?? err);
}

// Warn (don't fail) if an agent's native binary didn't land — that engine needs
// it. npm can skip these optional platform sub-packages during an in-place
// `npm i -g` upgrade; catching it here turns a mid-chat runtime error into an
// install-time hint. See scripts/agentBinaries.mjs.
try {
  prepareGrokBinary();
} catch (err) {
  console.warn('[postinstall] Grok binary preparation failed:', err?.message ?? err);
}
try {
  const missing = missingAgentBinaries();
  if (missing.length) {
    const plat = `${process.platform}-${process.arch}`;
    console.warn(`[postinstall] Warning: native ${missing.join(' and ')} binary (${plat}) is missing — ${missing.length > 1 ? 'those engines' : 'that engine'} will not work.`);
    console.warn('[postinstall] Fix: npm uninstall -g @surething/cockpit && npm install -g @surething/cockpit');
  }
} catch (err) {
  console.warn('[postinstall] agent binary check failed:', err?.message ?? err);
}

if (process.platform !== 'win32') {
  // node-pty: spawn-helper needs the executable bit
  try {
    const spawnHelper = join(
      projectRoot,
      `node_modules/node-pty/prebuilds/${process.platform}-${process.arch}/spawn-helper`,
    );
    accessSync(spawnHelper);
    execSync(`chmod +x "${spawnHelper}"`);
  } catch {}
}

// OpenCockpit Bridge native host: register it with every installed Chromium
// browser now, so the extension can connect before the first server boot
// (server.mjs refreshes it on every boot as well).
try {
  const { installNativeHost } = await import('./bridgeInstall.mjs');
  await installNativeHost();
} catch (err) {
  console.warn('[postinstall] native host registration failed:', err?.message ?? err);
}

// chrome-extension → ~/.cockpit/chrome-extension/
// Installed via npm: projectRoot sits under node_modules (no src/ dir) → copy into the user dir.
// Via npm link: projectRoot is the source checkout (has src/) → no copy needed.
const isNpmInstall = !existsSync(join(projectRoot, 'src'));
if (isNpmInstall) {
  try {
    const src = join(projectRoot, 'chrome-extension');
    const cockpitDir = join(homedir(), '.cockpit');
    const dest = join(cockpitDir, 'chrome-extension');
    accessSync(src);
    mkdirSync(cockpitDir, { recursive: true });
    // Replace, don't merge: files a newer extension dropped must not linger
    // in the folder Chrome loads (it is loaded unpacked from here).
    rmSync(dest, { recursive: true, force: true });
    cpSync(src, dest, { recursive: true, force: true });

    if (process.platform !== 'win32') {
      // Under a sudo install the files end up owned by root and Chrome can't
      // write _metadata/ — restore ownership to the real user via SUDO_USER
      const realUser = process.env.SUDO_USER;
      if (realUser) {
        try { execSync(`chown -R "${realUser}" "${cockpitDir}"`); } catch {}
      }
      // macOS: strip extended attributes like com.apple.provenance
      if (process.platform === 'darwin') {
        try { execSync(`xattr -cr "${dest}"`); } catch {}
      }
    }
  } catch {}
}
