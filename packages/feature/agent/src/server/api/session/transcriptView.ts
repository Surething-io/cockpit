// A session's transcript as readers should see it — including during an
// "independent task" (noHistory) turn.
//
// Such a turn moves the history aside for its whole duration (engines/shared/
// noHistoryTranscript.ts, noHistoryRollout.ts), so the file at `sessionPath` holds only
// the in-flight turn. Every reader that parses it then reports a one-turn session, and a
// client merging that into what it renders wipes the history — then reloads all of it
// when the turn is merged back. Readers go through here instead, and see the stash and
// the turn spliced exactly as the merge will write them.
import * as fs from 'fs';
import { readStashedTranscriptView, noHistoryStashPath } from '../../engines/shared/noHistoryTranscript';
import { readStashedCodexRolloutView, codexNoHistoryStashPath } from '../../engines/shared/noHistoryRollout';
import type { SessionEngine } from './sessionStore';
import type { TranscriptSource } from './transcriptParsers';

export interface TranscriptView {
  /** Changes whenever what `source()` returns could have changed. */
  fingerprint: string;
  /** Deferred so an `ifFingerprint` hit never reads a (possibly large) stash. */
  source(): TranscriptSource;
}

function statFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}-${stat.size}`;
}

/** Only the SDK engines stash; the Built-in Agent drops history in the prompt instead. */
function stashOf(sessionPath: string, engine: SessionEngine) {
  if (engine === 'claude') return { path: noHistoryStashPath(sessionPath), read: readStashedTranscriptView };
  if (engine === 'codex') return { path: codexNoHistoryStashPath(sessionPath), read: readStashedCodexRolloutView };
  return null;
}

export function openTranscriptView(sessionPath: string, engine: SessionEngine): TranscriptView {
  const plain = (): TranscriptView => ({ fingerprint: statFingerprint(sessionPath), source: () => sessionPath });
  const stash = stashOf(sessionPath, engine);
  if (!stash || !fs.existsSync(stash.path)) return plain();
  // Both halves: the turn grows while the stash is fixed, and the merge rewrites the file.
  let fingerprint: string;
  try {
    const turn = fs.existsSync(sessionPath) ? statFingerprint(sessionPath) : 'none';
    fingerprint = `${statFingerprint(stash.path)}+${turn}`;
  } catch {
    return plain(); // the merge consumed the stash between the check and the stat
  }
  return {
    fingerprint,
    // Null means the merge landed after the check above: the file is complete again.
    source: () => {
      const text = stash.read(sessionPath);
      return text === null ? sessionPath : { text };
    },
  };
}
