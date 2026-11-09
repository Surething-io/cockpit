import { createHash } from 'node:crypto';
import type { ChatMessage, TurnPage } from './api/session/transcriptParsers';
import { splitTurns } from '../shared/chatTurns';
import type { HistoryReference } from '../shared/historyReference';

/** Window proofs cover rendered content; target references cover source identity. */
function referenceProjection(messages: ChatMessage[], coordinateEpoch = '') {
  const hash = createHash('sha256').update(coordinateEpoch);
  const proofs = [hash.copy().digest('hex')];
  const referenced: ChatMessage[] = [];
  for (const turn of splitTurns(messages)) {
    for (const message of turn) {
      const { sourceRef: _reference, ...source } = message;
      hash.update(JSON.stringify(source)).update('\n');
      referenced.push(message.role === 'user' ? { ...source, sourceRef: {
        id: message.id, sourceId: message.sourceId,
        prefix: message.sourcePrefix
          ? createHash('sha256').update(JSON.stringify([coordinateEpoch, message.sourcePrefix])).digest('hex')
          : hash.copy().digest('hex'),
      } } : message);
    }
    proofs.push(hash.copy().digest('hex'));
  }
  return { referenced, proofs };
}

export function historyReferences(messages: ChatMessage[], coordinateEpoch?: string): ChatMessage[] {
  return referenceProjection(messages, coordinateEpoch).referenced;
}

export function historyWindow(messages: ChatMessage[], page: TurnPage & {
  expectedBeforeProof?: string; expectedStartProof?: string; target?: HistoryReference; coordinateEpoch?: string;
}) {
  const { referenced, proofs } = referenceProjection(messages, page.coordinateEpoch);
  const turns = splitTurns(referenced);
  let requested = page;
  let targetStatus: 'found' | 'missing' | 'stale' | undefined;
  let resolvedMessageId: string | undefined;
  if (page.target) {
    const target = page.target;
    const found = referenced.find((message) => target.sourceId
      ? message.sourceRef?.sourceId === target.sourceId
      : message.id === target.id && message.sourceRef?.prefix === target.prefix);
    targetStatus = found ? 'found' : target.sourceId ? 'missing' : 'stale';
    if (found) {
      resolvedMessageId = found.id;
      requested = { ...page, fromTurnIndex: Math.min(page.fromTurnIndex ?? Infinity, turns.findIndex((turn) => turn.includes(found))), beforeTurnIndex: undefined };
    }
  }
  const boundary = page.beforeTurnIndex ?? page.fromTurnIndex;
  const expected = page.expectedBeforeProof ?? page.expectedStartProof;
  const replacesWindow = expected !== undefined && (boundary === undefined || proofs[boundary] !== expected);
  // Invalid coordinates cannot be used to splice a prefix. Recover a bounded
  // tail with fresh proofs; subsequent paging starts from that new cursor.
  if (replacesWindow && !page.target) requested = { limit: page.limit ?? 10 };
  const end = requested.beforeTurnIndex ?? turns.length;
  const start = requested.fromTurnIndex !== undefined ? Math.min(Math.max(0, requested.fromTurnIndex), end)
    : requested.limit === undefined ? 0 : Math.max(0, end - requested.limit);
  const result = { messages: turns.slice(start, end).flat(), totalTurns: turns.length, startTurnIndex: start, hasMore: start > 0 };
  return { ...result, beforeProof: proofs[result.startTurnIndex],
    replacesWindow, targetStatus, resolvedMessageId };
}
