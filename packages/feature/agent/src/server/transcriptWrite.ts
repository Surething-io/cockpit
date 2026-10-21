/**
 * The one way Cockpit rewrites a transcript.
 *
 * Every derived view of a transcript (TranscriptIndex) is maintained on the premise
 * that the file only grows: a refresh parses the bytes past the last offset and
 * nothing before it. Engines' CLIs keep that premise by only appending. Cockpit's own
 * edits do not — deleting a turn, splicing an independent turn back onto its history,
 * reconciling a codex output style — so they all come through here, which keeps it
 * by construction:
 *
 *   1. write a sibling temp file, then rename it over the transcript — the path gets a
 *      new inode, which the index treats as "replaced, rebuild from byte 0";
 *   2. invalidate the in-process index entry, so even a refresh racing the rename
 *      cannot serve the old fold.
 *
 * The file mode is carried over (transcripts are owner-only), and the temp name ends
 * in `.tmp`, so no transcript listing ever picks it up.
 *
 * Pinned by constraints/transcript-rewrites-go-through-helper.test.ts.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import { chmod, mkdir, rename, rm, stat, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { invalidateTranscript } from '../effect/transcriptIndexLive';

const DEFAULT_MODE = 0o600;

const tempPathFor = (path: string): string => `${path}.${process.pid}.${randomUUID()}.tmp`;

/** Replace a transcript's content atomically (async). Creates it if missing. */
export async function rewriteTranscript(path: string, text: string): Promise<void> {
  const mode = await stat(path).then((st) => st.mode & 0o777, () => DEFAULT_MODE);
  await mkdir(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  try {
    await writeFile(tmp, text, { encoding: 'utf-8', mode });
    await chmod(tmp, mode); // writeFile's mode is masked by umask
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true }).catch(() => undefined);
    throw error;
  } finally {
    invalidateTranscript(path);
  }
}

/** Synchronous twin for the engine hooks that run between a turn's sync steps. */
export function rewriteTranscriptSync(path: string, text: string): void {
  let mode = DEFAULT_MODE;
  try {
    mode = fs.statSync(path).mode & 0o777;
  } catch {
    // new file
  }
  fs.mkdirSync(dirname(path), { recursive: true });
  const tmp = tempPathFor(path);
  try {
    fs.writeFileSync(tmp, text, { encoding: 'utf-8', mode });
    fs.chmodSync(tmp, mode);
    fs.renameSync(tmp, path);
  } catch (error) {
    fs.rmSync(tmp, { force: true });
    throw error;
  } finally {
    invalidateTranscript(path);
  }
}
