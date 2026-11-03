import { runGrokTurn } from '../../effect/grokRunLive';
import type { EngineSpec } from './types';

export const grokSpec: EngineSpec = {
  name: 'grok',
  preflight: async () => ({ ok: true }),
  runner: { run: runGrokTurn },
};
