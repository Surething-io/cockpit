import type { EngineSpec } from './types';
import { claudeSpec } from './claude';
import { deepseekSpec } from './deepseek';
import { ollamaSpec } from './ollama';
import { kimiSpec } from './kimi';
import { glmSpec } from './glm';
import { codexSpec } from './codex';

// engine name → spec. claude/claude2 share claudeSpec (the engine field selects claude2's
// CLAUDE_CONFIG_DIR inside the runner). Used by the scheduled-task manager to dispatch any
// engine in-process via the orchestrator — no HTTP loopback, no port.
const SPECS: Record<string, EngineSpec> = {
  claude: claudeSpec,
  claude2: claudeSpec,
  deepseek: deepseekSpec,
  ollama: ollamaSpec,
  kimi: kimiSpec,
  glm: glmSpec,
  codex: codexSpec,
};

export function getEngineSpec(engine: string | undefined): EngineSpec | undefined {
  return SPECS[engine ?? 'claude'];
}
