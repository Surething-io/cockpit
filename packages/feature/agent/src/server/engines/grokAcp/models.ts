import type { GrokModelCatalog } from '../../../shared/grokModels';
import { GROK_DEFAULT_MODEL } from '../../../shared/grokModels';
import { object, type AcpObject } from './client';

export function grokModelCatalog(initialized: AcpObject): GrokModelCatalog {
  const state = object(object(initialized._meta).modelState);
  const models: GrokModelCatalog['models'] = [];
  const seen = new Set<string>();
  for (const value of Array.isArray(state.availableModels) ? state.availableModels : []) {
    const model = object(value);
    if (typeof model.modelId !== 'string' || seen.has(model.modelId)) continue;
    seen.add(model.modelId);
    const meta = object(model._meta);
    const reasoning = meta.supportsReasoningEffort === false ? []
      : (Array.isArray(meta.reasoningEfforts) ? meta.reasoningEfforts : []).flatMap((entry) => {
        const option = object(entry);
        const id = option.value ?? option.id;
        return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,31}$/i.test(id)
          ? [{ id, label: String(option.label ?? id), isDefault: option.default === true || option.isDefault === true }] : [];
      });
    const rank = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
    if (reasoning.every((option) => rank.includes(option.id))) reasoning.sort((a, b) => rank.indexOf(a.id) - rank.indexOf(b.id));
    models.push({
      id: model.modelId, label: String(model.name || model.modelId),
      reasoning: reasoning.map(({ id, label }) => ({ id, label })),
      defaultReasoning: reasoning.find((option) => option.isDefault)?.id
        ?? reasoning.find((option) => option.id === meta.reasoningEffort)?.id,
    });
  }
  return { models, defaultModel: typeof state.currentModelId === 'string' && seen.has(state.currentModelId) ? state.currentModelId : models[0]?.id ?? GROK_DEFAULT_MODEL };
}
