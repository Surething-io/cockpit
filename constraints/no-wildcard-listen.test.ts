/**
 * Constraint: NoWildcardListen (architecture rule, L4).
 *
 * No server in this repo may hard-code a wildcard bind address. The only way to
 * listen beyond loopback is the operator's explicit `COCKPIT_HOST`, which the
 * main server reads and which is covered by the auth / origin gate.
 *
 * Why: the LAN review-share server bound `0.0.0.0` unconditionally, with a
 * raw-prefix route allowlist that `/review/%2e%2e/api/...` walked past — every
 * API (including `/api/bash`) was reachable from the LAN by default. The fix was
 * to delete that server; this check keeps a new one from being added back.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SCAN_ROOTS = ['server.mjs', 'bin', 'src', 'packages'];
const SKIP_DIRS = new Set(['node_modules', '.next', '.next-prod', 'dist']);
const SOURCE = /\.(m?[jt]sx?)$/;
const TEST = /\.test\.[jt]sx?$/;

// `.listen(<anything>, '0.0.0.0' | '::' | "" …)` with a literal wildcard host.
const WILDCARD_LISTEN = /\.listen\([^)]*?['"`](0\.0\.0\.0|::|)['"`]/;

function* walk(path: string): Generator<string> {
  const st = statSync(path);
  if (st.isFile()) {
    if (SOURCE.test(path) && !TEST.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) {
    if (SKIP_DIRS.has(name)) continue;
    yield* walk(join(path, name));
  }
}

describe('NoWildcardListen', () => {
  it('no source file binds a hard-coded wildcard address', () => {
    const hits: string[] = [];
    for (const root of SCAN_ROOTS) {
      for (const file of walk(join(ROOT, root))) {
        readFileSync(file, 'utf8').split('\n').forEach((line, i) => {
          if (WILDCARD_LISTEN.test(line)) hits.push(`${relative(ROOT, file)}:${i + 1}: ${line.trim()}`);
        });
      }
    }
    expect(hits).toEqual([]);
  });
});
