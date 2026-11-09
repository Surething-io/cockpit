import { splitTurns } from './chatTurns';

/** Native identities removed by a successful transcript edit. Never ordinal UI ids. */
export interface RecoveryDeletion {
  sourceIds: string[];
  taskIds: string[];
  sourceRemap?: Record<string, string>;
  /** Server clock (ms). Copies of runs started at or before it are invalid as a whole:
   *  their precise edit evidence was compacted away to keep the journal bounded. */
  clearsBefore?: number;
}

/** A recovery copy is independent of history, but respects explicit turn deletion. */
export function removeRecoveryTurns<T extends { id: string; role: 'user' | 'assistant' | 'system';
  sourceId?: string; sourceTaskId?: string; turnId?: string; turnUserId?: string }>(
  messages: T[], deletion: RecoveryDeletion,
): T[] {
  return splitTurns(messages).filter((turn) => !turn.some((row) =>
    (row.sourceId && deletion.sourceIds.includes(row.sourceId))
    || (row.sourceTaskId && deletion.taskIds.includes(row.sourceTaskId)))).flat().map((row) => {
      const sourceId = row.sourceId && deletion.sourceRemap?.[row.sourceId];
      return sourceId ? { ...row, sourceId } : row;
    });
}

/** A draining writer may settle recovery metadata, but cannot resume model output. */
export function isRecoverySettlement(event: unknown): boolean {
  const frame = event as { type?: string; subtype?: string; inputId?: unknown; sourceId?: unknown; undeliveredInputs?: unknown } | null;
  return (frame?.type === 'error' && Array.isArray(frame.undeliveredInputs) && frame.undeliveredInputs.length > 0)
    || (frame?.type === 'system' && frame.subtype === 'input_binding'
      && typeof frame.inputId === 'string' && typeof frame.sourceId === 'string');
}
