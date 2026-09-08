#!/usr/bin/env node
/**
 * Rebuild `public/tree-sitter/tree-sitter-lean.wasm` from source.
 *
 * MAINTAINER-ONLY. Unlike the other grammars, Lean's is NOT copied out of
 * `@vscode/tree-sitter-wasm` on every predev/prebuild — that package has no
 * Lean grammar, and upstream publishes no prebuilt artifact anywhere (no npm
 * package, no GitHub release, no tag, no wasm in the repo). So the `.wasm` is
 * committed to the repo as a vendored binary and this script exists to make
 * that binary reproducible. It is deliberately NOT wired into any npm
 * lifecycle hook and is not listed in `package.json#files`.
 *
 * Run it when:
 *   - `web-tree-sitter` is upgraded across an ABI boundary, or
 *   - you deliberately move GRAMMAR_SHA forward.
 *
 * Two versions must stay in lockstep, and getting this wrong is the known
 * failure mode of this whole area:
 *
 *   CLI_VERSION  must equal the `web-tree-sitter` version in package.json.
 *
 * The header of `copy-tree-sitter-wasms.mjs` records why: a mismatched CLI
 * emits a `.wasm` without the dylink section that newer runtimes require, and
 * the failure surfaces at runtime as "need dylink section", not at build time.
 * As of writing both are 0.26.8, producing ABI 15.
 *
 * GRAMMAR_SHA is pinned hard and must never be floated to a branch name. The
 * grammar has zero releases and zero tags, its node names were rewritten
 * wholesale in May–June 2026, and upstream has no semver signal — a rename
 * would silently break `extractSymbols.ts` with no build error. `queries/`
 * from the same SHA is the reference for which node types are expected.
 *
 * Build cost: the checked-in `src/parser.c` is ~42 MB, and the resulting wasm
 * is ~7.2 MB (~434 KB gzipped over the wire, which is what actually matters —
 * the browser fetches this from `/tree-sitter/`).
 */

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const PROJECT_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

/** github.com/Julian/tree-sitter-lean — the only maintained Lean 4 grammar. */
const GRAMMAR_REPO = 'Julian/tree-sitter-lean';
const GRAMMAR_SHA = '259a2daf';
/** MUST equal `web-tree-sitter` in package.json. See header. */
const CLI_VERSION = '0.26.8';

const DEST = join(PROJECT_ROOT, 'public', 'tree-sitter', 'tree-sitter-lean.wasm');

function run(cmd, args, cwd) {
  execFileSync(cmd, args, { cwd, stdio: 'inherit' });
}

function assertCliMatchesRuntime() {
  const pkg = JSON.parse(
    execFileSync('cat', [join(PROJECT_ROOT, 'package.json')], { encoding: 'utf8' }),
  );
  const runtime = (pkg.dependencies?.['web-tree-sitter'] ?? '').replace(/^[^0-9]*/, '');
  if (runtime && runtime !== CLI_VERSION) {
    throw new Error(
      `tree-sitter-cli pin (${CLI_VERSION}) != web-tree-sitter (${runtime}). ` +
        'Bump CLI_VERSION in this script to match, or the wasm may be built ' +
        'for the wrong ABI (see header).',
    );
  }
}

function main() {
  assertCliMatchesRuntime();

  const work = mkdtempSync(join(tmpdir(), 'ts-lean-'));
  try {
    const url = `https://github.com/${GRAMMAR_REPO}/archive/${GRAMMAR_SHA}.tar.gz`;
    console.log(`[build-lean-grammar] fetching ${GRAMMAR_REPO}@${GRAMMAR_SHA}`);
    run('curl', ['-sSL', '--max-time', '300', url, '-o', join(work, 'g.tgz')]);
    // --strip-components=1 drops the `tree-sitter-lean-<sha>/` wrapper dir,
    // whose name depends on how the SHA was spelled in the URL.
    run('tar', ['xzf', join(work, 'g.tgz'), '-C', work, '--strip-components=1']);

    console.log(`[build-lean-grammar] building with tree-sitter-cli@${CLI_VERSION}`);
    // The CLI downloads a wasi-sdk into ~/.cache/tree-sitter on first use;
    // no Docker or system emscripten is required.
    run('npx', ['--yes', `tree-sitter-cli@${CLI_VERSION}`, 'build', '--wasm', '.'], work);

    const built = join(work, 'tree-sitter-lean.wasm');
    if (!existsSync(built)) throw new Error(`build produced no wasm at ${built}`);
    copyFileSync(built, DEST);
    const mb = (statSync(DEST).size / 1048576).toFixed(1);
    console.log(`[build-lean-grammar] ✓ ${DEST} (${mb} MB)`);
    console.log(
      '[build-lean-grammar] verify the ABI and re-run the extractor tests:\n' +
        '  npx vitest run packages/feature/explorer/src/server/codeMap/',
    );
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
