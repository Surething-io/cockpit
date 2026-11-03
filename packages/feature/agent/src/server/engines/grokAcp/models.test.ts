import { describe, expect, it } from 'vitest';
import { grokModelCatalog } from './models';

describe('Grok ACP model catalog', () => {
  it('uses advertised models, per-model reasoning levels and defaults, tolerating unknown metadata', () => {
    const catalog = grokModelCatalog({ _meta: { modelState: {
      currentModelId: 'grok-latest', availableModels: [
        null, { name: 'Invalid' },
        { modelId: 'grok-fast', name: 'Grok Fast', _meta: { supportsReasoningEffort: false, reasoningEfforts: [{ id: 'high' }] } },
        { modelId: 'grok-latest', name: 'Grok Latest', _meta: { reasoningEffort: 'high', reasoningEfforts: [
          { value: 'high', label: 'High effort', default: true },
          { id: 'low', label: 'Low effort' }, { value: '<invalid>' }, null,
        ] } },
        { modelId: 'grok-latest', name: 'Duplicate' },
      ],
    } } });
    expect(catalog).toEqual({ defaultModel: 'grok-latest', models: [
      { id: 'grok-fast', label: 'Grok Fast', reasoning: [], defaultReasoning: undefined },
      { id: 'grok-latest', label: 'Grok Latest', reasoning: [{ id: 'low', label: 'Low effort' }, { id: 'high', label: 'High effort' }], defaultReasoning: 'high' },
    ] });
    expect(grokModelCatalog({})).toEqual({ models: [], defaultModel: 'grok-4.7' });
  });
});
