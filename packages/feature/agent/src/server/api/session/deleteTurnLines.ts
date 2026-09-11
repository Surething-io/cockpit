import { isHumanTurnStart } from '../../../shared/transcriptTurns';

export interface DeleteTurnResult {
  newLines: string[];
  deletedLineCount: number;
  targetMissed: boolean;
}

/**
 * Remove one human turn from a Claude-style transcript.
 *
 * A turn starts at a real human message and includes every assistant, tool-result and
 * harness-injected line up to the next real human message. When a middle turn is removed,
 * the next surviving entry may still point at a deleted uuid; reconnect that seam to the
 * last surviving uuid before the removed turn so SDK resume still sees one valid chain.
 */
export function deleteClaudeTurnLines(
  originalLines: string[],
  targetMessageUuid: string,
): DeleteTurnResult {
  const parsed: Array<Record<string, unknown> | null> = [];
  const turnByLine: number[] = [];
  let currentTurn = -1;
  let targetTurn = -1;

  for (const line of originalLines) {
    let entry: Record<string, unknown> | null = null;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      // Preserve corrupt/unknown lines with the surrounding turn. The same policy is used
      // by prefix forks: deletion must not silently "repair" unrelated transcript bytes.
    }
    if (entry && isHumanTurnStart(entry)) currentTurn += 1;
    parsed.push(entry);
    turnByLine.push(currentTurn);
    if (entry?.uuid === targetMessageUuid && currentTurn >= 0) targetTurn = currentTurn;
  }

  if (targetTurn < 0) {
    return { newLines: [], deletedLineCount: 0, targetMissed: true };
  }

  const deletedUuids = new Set<string>();
  let deletedLineCount = 0;
  let replacementParent: string | null = null;
  for (let i = 0; i < originalLines.length; i += 1) {
    const entry = parsed[i];
    if (turnByLine[i] === targetTurn) {
      deletedLineCount += 1;
      if (typeof entry?.uuid === 'string') deletedUuids.add(entry.uuid);
    } else if (turnByLine[i] < targetTurn && typeof entry?.uuid === 'string') {
      replacementParent = entry.uuid;
    }
  }

  const newLines: string[] = [];
  for (let i = 0; i < originalLines.length; i += 1) {
    if (turnByLine[i] === targetTurn) continue;
    const entry = parsed[i];
    if (entry && typeof entry.parentUuid === 'string' && deletedUuids.has(entry.parentUuid)) {
      entry.parentUuid = replacementParent;
      newLines.push(JSON.stringify(entry));
    } else {
      newLines.push(originalLines[i]);
    }
  }

  return { newLines, deletedLineCount, targetMissed: false };
}
