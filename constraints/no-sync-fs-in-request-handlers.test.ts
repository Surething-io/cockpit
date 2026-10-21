/**
 * Constraint: NoSyncIoInRequestHandlers (architecture rule, ratchet).
 *
 * HTTP handlers (`packages/feature/<x>/src/server/api/**`, `src/app/api/**`) must
 * not call `*Sync(` APIs. The server is one process: a synchronous read inside a
 * handler stalls every other request, every WebSocket and every running agent
 * stream for as long as it takes.
 *
 * Why: /api/sessions/projects read whole transcripts with readFileSync to find a
 * project's cwd (0.3–0.5 s per call, up to 60 MB per file), and the session list
 * re-parsed transcripts on every open. Transcript-derived data now comes from the
 * TranscriptIndex service; filesystem IO goes through fs/promises (EFFECT.md §0).
 *
 * Ratchet: BASELINE lists the handlers that still did this when the rule landed.
 * It may only shrink — a listed file that no longer matches fails the test until
 * it is removed from the list, so a cleanup cannot silently regress.
 */
import { readFileSync, readdirSync, statSync } from 'fs';
import { join, relative, sep } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const SOURCE = /\.tsx?$/;
const TEST = /\.test\.tsx?$/;
const SYNC_CALL = /\b[A-Za-z]+Sync\(/;

const BASELINE = new Set([
  'packages/feature/agent/src/server/api/ollama/start.ts',
  'packages/feature/agent/src/server/api/scheduled-tasks.ts',
  'packages/feature/agent/src/server/api/session-by-path.ts',
  'packages/feature/agent/src/server/api/session/sessionArtifacts.ts',
  'packages/feature/agent/src/server/api/session/transcriptView.ts',
  'packages/feature/explorer/src/server/api/files/clipboard.ts',
  'src/app/api/extension/version/route.ts',
  'src/app/api/services/scripts/route.ts',
  'src/app/api/shutdown/route.ts',
  'src/app/api/version/route.ts',
]);

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
  for (const name of readdirSync(path)) {
    if (name === 'node_modules') continue;
    yield* walk(join(path, name));
  }
}

function handlerRoots(): string[] {
  const features = join(ROOT, 'packages', 'feature');
  return [
    join(ROOT, 'src', 'app', 'api'),
    ...readdirSync(features).map((f) => join(features, f, 'src', 'server', 'api')),
  ];
}

function offenders(): string[] {
  const out: string[] = [];
  for (const root of handlerRoots()) {
    for (const file of walk(root)) {
      const text = readFileSync(file, 'utf8');
      if (SYNC_CALL.test(text)) out.push(relative(ROOT, file).split(sep).join('/'));
    }
  }
  return out.sort();
}

describe('NoSyncIoInRequestHandlers', () => {
  const found = offenders();

  it('no handler outside the baseline calls a *Sync( API', () => {
    expect(found.filter((f) => !BASELINE.has(f))).toEqual([]);
  });

  it('the baseline only shrinks: every listed file still matches', () => {
    expect([...BASELINE].filter((f) => !found.includes(f))).toEqual([]);
  });
});
