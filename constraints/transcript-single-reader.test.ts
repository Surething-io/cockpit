/**
 * Constraint: TranscriptSingleReader (architecture rule, L3).
 *
 * Code that works over MANY sessions — Live layers, the recent-session state, the
 * session list / project list / usage-stats handlers — reads transcript-derived data
 * from TranscriptIndex only. It does not open, stream or parse a transcript itself.
 * Reading one session on demand for display (the chat view, a delegated session's
 * last reply) is a different job and stays with the display parsers.
 *
 * Why: every scan-style reader used to re-parse raw JSONL behind its own cache — a
 * 40-entry LRU, a 5-minute TTL, a per-project list cache, the search corpus's
 * fingerprint manifest — so each paid for the whole history (hundreds of MB) again on
 * any miss. The index pays for each appended byte once.
 *
 * Detection: in the scan-style modules, no createReadStream, no readline, no import of
 * the display parsers (transcriptParsers). The index itself is the one exception, and
 * delegationLive reads a single session's last reply on demand.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const AGENT = 'packages/feature/agent/src';
const SCAN_MODULES = [
  `${AGENT}/effect`,
  `${AGENT}/server/state`,
  `${AGENT}/server/api/sessions`,
  `${AGENT}/server/api/claude-stats.ts`,
  `${AGENT}/server/api/global-state.ts`,
];
const ALLOWED = new Set([
  `${AGENT}/effect/transcriptIndexLive.ts`, // the single reader
  `${AGENT}/effect/delegationLive.ts`, // one session's last reply, on demand
]);
const SOURCE = /\.tsx?$/;
const TEST = /\.test\.tsx?$/;
const READS_TRANSCRIPTS = /\bcreateReadStream\b|from ['"](node:)?readline['"]|transcriptParsers['"]/;

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

describe('TranscriptSingleReader', () => {
  it('scan-style modules read transcripts through TranscriptIndex only', () => {
    const offenders: string[] = [];
    for (const scope of SCAN_MODULES) {
      for (const file of walk(join(ROOT, scope))) {
        const rel = relative(ROOT, file).split(sep).join('/');
        if (ALLOWED.has(rel)) continue;
        if (READS_TRANSCRIPTS.test(readFileSync(file, 'utf8'))) offenders.push(rel);
      }
    }
    expect(offenders).toEqual([]);
  });
});
