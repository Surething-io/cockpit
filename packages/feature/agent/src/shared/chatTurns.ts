export interface TurnMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  /** A notice preceding its user in the same source message belongs to that user's turn. */
  turnUserId?: string;
  /** Codex task ownership; steering inputs share the task's atomic edit boundary. */
  turnId?: string;
}

/** Use explicit task ownership, or one human input plus its leading notices. */
export function splitTurns<T extends TurnMessage>(messages: T[]): T[][] {
  const turns: T[][] = [];
  let currentTurn: T[] = [];
  let currentTurnId: string | undefined;
  let pendingUserId: string | undefined;
  let hasUser = false;
  for (const message of messages) {
    const startsTurn = message.turnId !== undefined
      ? message.turnId !== currentTurnId
      : message.role === 'user'
        ? hasUser || pendingUserId !== message.id
        : message.turnUserId !== undefined && (hasUser || pendingUserId !== message.turnUserId);
    if (startsTurn) {
      if (currentTurn.length > 0) turns.push(currentTurn);
      currentTurn = [];
      pendingUserId = undefined;
      hasUser = false;
    }
    currentTurn.push(message);
    currentTurnId = message.turnId;
    if (message.role === 'user') hasUser = true;
    else if (message.turnUserId !== undefined) pendingUserId = message.turnUserId;
  }
  if (currentTurn.length > 0) turns.push(currentTurn);
  return turns;
}

/** The optimistic client removal uses the same turn membership as server pagination. */
export function removeMessageTurn<T extends TurnMessage>(messages: T[], messageId: string): T[] {
  const turns = splitTurns(messages);
  const target = turns.findIndex((turn) => turn.some((message) => message.id === messageId));
  return target < 0 ? messages : turns.filter((_, index) => index !== target).flat();
}
