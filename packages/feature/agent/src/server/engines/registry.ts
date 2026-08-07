import type { EngineSpec } from './types';
import { claudeSpec } from './claude';
import { deepseekSpec } from './deepseek';
import { ollamaSpec } from './ollama';
import { kimiSpec } from './kimi';
import { glmSpec } from './glm';
import { codexSpec } from './codex';

// engine name → spec. Used by the scheduled-task manager to dispatch any
// engine in-process via the orchestrator — no HTTP loopback, no port.
const SPECS: Record<string, EngineSpec> = {
  claude: claudeSpec,
  deepseek: deepseekSpec,
  ollama: ollamaSpec,
  kimi: kimiSpec,
  glm: glmSpec,
  codex: codexSpec,
};

export function getEngineSpec(engine: string | undefined): EngineSpec | undefined {
  return SPECS[engine ?? 'claude'];
}
