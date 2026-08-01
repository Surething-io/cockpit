/**
 * Ollama engine — a thin provider binding over the Built-in Agent loop.
 *
 * All the machinery (loop, tools, transcript, system prompt) lives in
 * engines/builtinAgent; this file only says WHICH model provider to talk to and
 * WHERE the transcripts go. The store directory keeps its historical name
 * (~/.cockpit/ollama-sessions) — renaming it would orphan every existing session.
 */
import { getBuiltinSessionsRoot } from '@cockpit/shared-utils';
import { runBuiltinAgent, requireTextPrompt, type BuiltinAgentConfig } from './builtinAgent';
import { createOllamaModel } from './builtinAgent/model';
import type { EngineSpec } from './types';

const DEFAULT_MODEL = 'qwen3.5:35b-a3b-coding-nvfp4';

const OLLAMA_CONFIG: BuiltinAgentConfig = {
  sessionsRoot: getBuiltinSessionsRoot('ollama'),
  defaultModel: DEFAULT_MODEL,
  createModel: (model) => createOllamaModel(model),
};

export const ollamaSpec: EngineSpec = {
  name: 'ollama',
  async preflight(params) {
    return requireTextPrompt(params);
  },
  runner: {
    run: (ctx) => runBuiltinAgent(ctx, OLLAMA_CONFIG),
    // No resolveTitle → teardown uses 'unread' with undefined title.
  },
};
