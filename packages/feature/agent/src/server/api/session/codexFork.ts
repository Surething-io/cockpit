import {
  CODEX_AGENT_FN_NAMES,
  CODEX_SPAWN_FN_NAME,
  CODEX_WAIT_FN_NAME,
  extractCodexUserContent,
} from './codexTools';

export type CodexForkScope = 'prefix' | 'single';

interface CodexForkState {
  msgCounter: number;
  assistantOpen: boolean;
  spawnCallIds: Set<string>;
  waitCallIds: Set<string>;
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
    content?: Array<{ type?: string; text?: string; image_url?: string }>;
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

    if (payload.type === 'function_call' && payload.name) {
      if (payload.name === CODEX_WAIT_FN_NAME && payload.call_id) state.waitCallIds.add(payload.call_id);
      const isAgentPlumbing = CODEX_AGENT_FN_NAMES.has(payload.name) && payload.name !== CODEX_SPAWN_FN_NAME;
      if (!isAgentPlumbing) {
        const id = ensureCodexAssistantId(state);
        if (id) ids.push(id);
        if (payload.name === CODEX_SPAWN_FN_NAME && payload.call_id) state.spawnCallIds.add(payload.call_id);
      }
    }

    if (
      (payload.type === 'custom_tool_call' && payload.name === 'apply_patch') ||
      (payload.type === 'custom_tool_call_output' && payload.call_id)
    ) {
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

  if (entry.type === 'event_msg' && payload.type === 'web_search_end' && payload.call_id) {
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
