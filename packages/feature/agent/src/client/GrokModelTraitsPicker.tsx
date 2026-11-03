'use client';

import { TraitSelect } from './AgentModelTraitsPicker';
import { EngineIcon } from './engineAccents';
import { formatModelLabel } from './modelLabel';
import { GROK_DEFAULT_MODEL, GROK_DEFAULT_REASONING, GROK_MODEL_CATALOG } from '../shared/grokModels';

interface Props {
  model?: string;
  reasoningEffort?: string;
  onModelChange?: (model: string) => void;
  onReasoningEffortChange?: (effort: string) => void;
}

export function GrokModelTraitsPicker(props: Props) {
  const catalog = GROK_MODEL_CATALOG;
  const selected = props.model && props.model !== 'grok-build' ? props.model : GROK_DEFAULT_MODEL;
  const descriptor = catalog.models.find((model) => model.id === selected);
  const models = catalog.models.map((model) => ({ id: model.id, label: model.label, defaultValue: model.id === catalog.defaultModel }));
  if (!models.some((model) => model.id === selected)) models.unshift({ id: selected, label: formatModelLabel(selected), defaultValue: false });
  const reasoning = descriptor?.reasoning ?? catalog.models[0].reasoning;
  const effort = reasoning.some((option) => option.id === props.reasoningEffort)
    ? props.reasoningEffort! : descriptor?.defaultReasoning ?? GROK_DEFAULT_REASONING;
  return <div className="flex min-w-0 items-center gap-1" data-agent-model-traits>
    <TraitSelect title="Model" selected={selected} value={descriptor?.label ?? models.find((model) => model.id === selected)!.label} items={models}
      onSelect={(model) => {
        props.onModelChange?.(model);
        props.onReasoningEffortChange?.(catalog.models.find((candidate) => candidate.id === model)?.defaultReasoning ?? GROK_DEFAULT_REASONING);
      }} icon={<EngineIcon engine="grok" />} testId="grok-model-picker" />
    <TraitSelect title="Reasoning" selected={effort} value={reasoning.find((option) => option.id === effort)?.label ?? effort}
      items={reasoning.map((option) => ({ ...option, defaultValue: option.id === (descriptor?.defaultReasoning ?? GROK_DEFAULT_REASONING) }))}
      onSelect={(value) => props.onReasoningEffortChange?.(value)} testId="grok-reasoning-picker" />
  </div>;
}
