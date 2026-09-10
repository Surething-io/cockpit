import {
  CODEX_CUSTOM_TOOL_NAMES,
  CODEX_EXEC_SCRIPT_FN_NAME,
  codexItemBubble,
  parseCodexExecScript,
  type CodexItemLike,
  CODEX_SPAWN_FN_NAME,
  CODEX_WAIT_FN_NAME,
  extractCodexUserContent,
  parseCodexUnknownCall,
} from './codexTools';

export type CodexForkScope = 'prefix' | 'single';

interface CodexForkState {
  msgCounter: number;
  assistantOpen: boolean;
  spawnCallIds: Set<string>;
  waitCallIds: Set<string>;
  /** Mirrors the parser's draw-once guard; see it for why. */
  drawnToolIds: Set<string>;
}

function isCodexTaskStarted(entry: Record<string, unknown>): boolean {
  const payload = entry.payload as { type?: unknown } | undefined;
  return entry.type === 'event_msg' && payload?.type === 'task_started';
}

function isCodexTaskComplete(entry: Record<string, unknown>): boolean {
  const payload = entry.payload as { type?: unknown } | undefined;
  return entry.type === 'event_msg' && payload?.type === 'task_complete';
}

function ensureCodexAssistantId(state: CodexForkState): string | null {
  if (state.assistantOpen) return null;
  const id = `codex-assistant-${state.msgCounter++}`;
  state.assistantOpen = true;
  return id;
}

function codexVisibleMessageIds(
  entry: Record<string, unknown>,
  state: CodexForkState
): string[] {
  const payload = entry.payload as {
    type?: string;
    role?: string;
    name?: string;
    call_id?: string;
    input?: string;
    content?: Array<{ type?: string; text?: string; image_url?: string }>;
    error?: { message?: string };
    item?: CodexItemLike;
  } | undefined;
  if (!payload) return [];

  const ids: string[] = [];
  if (entry.type === 'response_item') {
    if (payload.type === 'message' && payload.role === 'user') {
      const { text, images } = extractCodexUserContent(payload.content);
      if (images.length > 0 || (text && !text.startsWith('<') && !text.startsWith('#'))) {
        state.assistantOpen = false;
        ids.push(`codex-user-${state.msgCounter++}`);
      }
    }

    if (payload.type === 'message' && payload.role === 'assistant') {
      const text = payload.content
        ?.filter((c) => c.type === 'output_text' && c.text)
        .map((c) => c.text!)
        .join('') || '';
      if (text) {
        const id = ensureCodexAssistantId(state);
        if (id) ids.push(id);
      }
    }

    // Only `spawn_agent` draws a bubble from a function_call now; every other
    // named tool is drawn from its completed item instead.
    if (payload.type === 'function_call' && payload.name) {
      if (payload.name === CODEX_WAIT_FN_NAME && payload.call_id) state.waitCallIds.add(payload.call_id);
      if (payload.name === CODEX_SPAWN_FN_NAME) {
        const id = ensureCodexAssistantId(state);
        if (id) ids.push(id);
        if (payload.call_id) state.spawnCallIds.add(payload.call_id);
      }
    }

    /**
     * The parser's exception path: a custom tool call draws a bubble ONLY when
     * no completed item will arrive for it — an `exec` script that runs no
     * command line, or a tool name it has never heard of. Mirrored condition
     * for condition; if the two drift, a fork cuts at the wrong message.
     */
    if (payload.type === 'custom_tool_call' && payload.name) {
      const known = CODEX_CUSTOM_TOOL_NAMES.has(payload.name);
      const isExecScript = payload.name === CODEX_EXEC_SCRIPT_FN_NAME;
      const execKind = isExecScript ? parseCodexExecScript(payload.input || '').kind : null;
      const producesItem = known && (!isExecScript || execKind === 'exec' || execKind === 'patch');
      if (!producesItem) {
        const id = ensureCodexAssistantId(state);
        if (id) ids.push(id);
      }
    }

    // The paired output always opens one, exactly as the parser does.
    if (payload.type === 'custom_tool_call_output' && payload.call_id) {
      const id = ensureCodexAssistantId(state);
      if (id) ids.push(id);
    }

    // Same for the parser's unknown-tool fallback: any other response_item with a
    // call_id becomes a bubble there, so it opens an assistant message here too.
    // Both the call and its paired output route through one branch on each side.
    if (parseCodexUnknownCall(payload)) {
      const id = ensureCodexAssistantId(state);
      if (id) ids.push(id);
    }

    if (
      payload.type === 'function_call_output' &&
      payload.call_id &&
      !state.spawnCallIds.has(payload.call_id) &&
      !state.waitCallIds.has(payload.call_id)
    ) {
      const id = ensureCodexAssistantId(state);
      if (id) ids.push(id);
    }
  }

  /**
   * Tool bubbles now come from the completed item, so this is where most of a
   * turn's assistant messages are opened. Mirrors the parser's
   * `codexItemBubble` branch — including its "no bubble, no open" for items
   * that draw nothing (messages, reasoning).
   */
  if (entry.type === 'event_msg' && payload.type === 'item_completed' && payload.item) {
    const bubble = codexItemBubble(payload.item as CodexItemLike);
    if (bubble && !state.drawnToolIds.has(bubble.id)) {
      state.drawnToolIds.add(bubble.id);
      const id = ensureCodexAssistantId(state);
      if (id) ids.push(id);
    }
  }

  if (entry.type === 'event_msg' && payload.type === 'web_search_end' && payload.call_id
      && !state.drawnToolIds.has(payload.call_id)) {
    state.drawnToolIds.add(payload.call_id);
    const id = ensureCodexAssistantId(state);
    if (id) ids.push(id);
  }

  // A failed turn's ⚠️ banner is a bubble in the parser, so it opens an assistant
  // message here too. Must stay ahead of the caller's finishTurn() on the same line
  // (it is — the ids are collected first), or the id lands in the following turn.
  if (entry.type === 'event_msg' && payload.type === 'task_complete' && payload.error?.message) {
    const id = ensureCodexAssistantId(state);
    if (id) ids.push(id);
  }

  if (entry.type === 'response_completed') {
    state.assistantOpen = false;
  }

  return ids;
}

function replaceSessionId(lines: string[], originalSessionId: string, newSessionId: string): string[] {
  const escaped = originalSessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(escaped, 'g');
  return lines.map((line) => line.replace(re, newSessionId));
}

export function buildCodexForkLines(
  originalLines: string[],
  originalSessionId: string,
  newSessionId: string,
  fromMessageUuid: string | undefined,
  scope: CodexForkScope
): { newLines: string[]; targetMissed: boolean } {
  if (!fromMessageUuid) {
    return {
      newLines: replaceSessionId(originalLines, originalSessionId, newSessionId),
      targetMissed: false,
    };
  }

  const metaLine = originalLines.find((line) => {
    try {
      return JSON.parse(line).type === 'session_meta';
    } catch {
      return false;
    }
  });
  if (!metaLine) return { newLines: [], targetMissed: true };

  const turns: string[][] = [];
  const state: CodexForkState = {
    msgCounter: 0,
    assistantOpen: false,
    spawnCallIds: new Set(),
    waitCallIds: new Set(),
    drawnToolIds: new Set(),
  };
  let currentTurn: string[] = [];
  let targetTurn = -1;

  const finishTurn = () => {
    if (currentTurn.length === 0) return;
    turns.push(currentTurn);
    currentTurn = [];
    state.assistantOpen = false;
  };

  for (const line of originalLines) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = JSON.parse(line) as Record<string, unknown>;
    } catch {
      if (currentTurn.length > 0) currentTurn.push(line);
      continue;
    }
    if (entry.type === 'session_meta') continue;

    if (isCodexTaskStarted(entry) && currentTurn.length > 0) finishTurn();
    currentTurn.push(line);

    const ids = codexVisibleMessageIds(entry, state);
    if (ids.includes(fromMessageUuid)) targetTurn = turns.length;

    if (isCodexTaskComplete(entry)) finishTurn();
  }
  finishTurn();

  if (targetTurn < 0) return { newLines: [], targetMissed: true };

  const keptTurns = scope === 'single'
    ? turns.slice(targetTurn, targetTurn + 1)
    : turns.slice(0, targetTurn + 1);
  return {
    newLines: replaceSessionId([metaLine, ...keptTurns.flat()], originalSessionId, newSessionId),
    targetMissed: false,
  };
}
