import { DEFAULT_CLAUDE_MODEL, DEFAULT_CODEX_MODEL } from './AgentModelTraitsPicker';
import type { ChatEngine, EngineModelId, ClaudeModelId, CodexModelId } from './types';

/** The per-tab settings a scheduled task inherits — a subset of the tab record. */
export interface ScheduleSource {
  cwd: string;
  tabId: string;
  sessionId?: string;
  engine?: ChatEngine;
  ollamaModel?: string;
  kimiModel?: EngineModelId;
  glmModel?: EngineModelId;
  deepseekModel?: EngineModelId;
  claudeModel?: ClaudeModelId;
  codexModel?: CodexModelId;
}

/**
 * Which session, engine and model a scheduled task created from a tab runs on.
 * The model resolves the same way the chat's picker does (unset → the engine's
 * default), so the task runs on what the tab shows.
 */
export function scheduleTarget(s: ScheduleSource) {
  const engine = s.engine;
  const model =
    engine === 'ollama' ? s.ollamaModel
    : engine === 'kimi' ? s.kimiModel
    : engine === 'glm' ? s.glmModel
    : engine === 'deepseek' ? s.deepseekModel
    : engine === 'codex' ? (s.codexModel ?? DEFAULT_CODEX_MODEL)
    : (s.claudeModel ?? DEFAULT_CLAUDE_MODEL);
  return {
    cwd: s.cwd,
    tabId: s.tabId,
    // A brand-new chat has no session yet. Rather than block scheduling, hand the
    // task a random id: it misses every engine's session-file lookup, so the first
    // fire takes the existing startFresh path (see scheduledTasks.ts) and rebinds
    // the task to the session the engine mints. Must NOT be '': an empty id is not a
    // session key in any store, and lookups that build paths from it (a glob in the
    // old codex resolver) can land on an unrelated file.
    sessionId: s.sessionId ?? crypto.randomUUID(),
    engine,
    ...(model && { model }),
  };
}
