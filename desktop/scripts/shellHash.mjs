// The desktop shell's fingerprint: Git's tree hash of desktop/ at HEAD.
//
// The app is a thin shell that rarely changes, while the npm package ships
// every few days. Updating the app on every cockpit release would mean a
// 100 MB+ download for nothing, so the app only updates when this fingerprint
// differs from the one recorded in the npm package (desktop-checksums.json).
//
// A Git tree hash covers every tracked file under desktop/ — sources, lock
// file, build config — and is computed from normalized blobs, so the macOS,
// Windows and Linux CI jobs all get the same value for the same commit.
import { execFileSync } from 'child_process';

/**
 * @param {string} root repository root
 * @returns {string} tree hash; suffixed `-dirty` when desktop/ has uncommitted
 *   changes (a local build that matches no release), `unknown` without Git.
 */
export function shellHash(root) {
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
  let tree;
  try {
    tree = git('rev-parse', 'HEAD:desktop');
  } catch {
    return 'unknown';
  }
  // CI checks out a clean tree; skipping the check there keeps a Windows
  // line-ending quirk from ever marking a release build dirty.
  if (!process.env.CI) {
    try {
      if (git('status', '--porcelain', '--', 'desktop')) return `${tree}-dirty`;
    } catch {
      // Treat an unreadable status as clean: the tree hash still identifies it.
    }
  }
  return tree;
}
