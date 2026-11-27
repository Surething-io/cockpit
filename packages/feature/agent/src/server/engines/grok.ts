import { SETTINGS_FILE } from '@cockpit/shared-utils';
import { runGrokTurn } from '../../effect/grokRunLive';
import { suggestGrokTitle } from './grokTitle';
import type { EngineSpec } from './types';

export const grokSpec: EngineSpec = {
  name: 'grok',
  preflight: async () => ({ ok: true }),
  runner: { run: runGrokTurn },
  suggestTitle: (req) => suggestGrokTitle(req, { settingsPath: SETTINGS_FILE }),
};
