/**
 * Constraint: TranscriptRewritesGoThroughHelper (architecture rule, L3).
 *
 * The modules that own transcripts may append to them, but must not overwrite or
 * truncate them in place — every rewrite goes through `rewriteTranscript` /
 * `rewriteTranscriptSync` (packages/feature/agent/src/server/transcriptWrite.ts),
 * which replaces the file atomically (new inode) and invalidates the transcript index.
 *
 * Why: TranscriptIndex folds a transcript incrementally — it parses only the bytes
 * past its last offset. Deleting a turn rewrote the file in place (same inode), so a
 * rewrite that kept the tail bytes and the size looked like "nothing to re-read" and
 * the index kept serving the deleted turn's title and messages.
 *
 * Scope: the modules that write transcripts — session editing (api/session/), the
 * engine-side transcript hooks (engines/shared/) and the Built-in Agent's session
 * store. Renames are allowed: a rename onto a path gives it a new inode, which the
 * index already treats as a replaced file.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const AGENT = 'packages/feature/agent/src/server';
const SCOPE = [
  `${AGENT}/api/session`,
  `${AGENT}/engines/shared`,
  `${AGENT}/engines/builtinAgent/session.ts`,
];
const SOURCE = /\.tsx?$/;
const TEST = /\.test\.tsx?$/;
const OVERWRITE = /\b(writeFile|writeFileSync|truncate|truncateSync|ftruncate|ftruncateSync|createWriteStream)\(/;

function* walk(path: string): Generator<string> {
  let st;
  try {
    st = statSync(path);
  } catch {
    return;
  }
  if (st.isFile()) {
    if (SOURCE.test(path) && !TEST.test(path)) yield path;
    return;
  }
  for (const name of readdirSync(path)) yield* walk(join(path, name));
}

function offenders(): string[] {
  const out: string[] = [];
  for (const scope of SCOPE) {
    for (const file of walk(join(ROOT, scope))) {
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (OVERWRITE.test(line)) out.push(`${relative(ROOT, file).split(sep).join('/')}:${i + 1}`);
        });
    }
  }
  return out;
}

describe('TranscriptRewritesGoThroughHelper', () => {
  it('no transcript-owning module overwrites a file in place', () => {
    expect(offenders()).toEqual([]);
  });
});
