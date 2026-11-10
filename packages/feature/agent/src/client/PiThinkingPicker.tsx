'use client';

import { TraitSelect } from './AgentModelTraitsPicker';
import type { PiThinkingLevel, PiThinkingOptions } from '../shared/piThinking';

export function PiThinkingPicker({ options, level, onChange }: {
  options?: PiThinkingOptions;
  level?: PiThinkingLevel;
  onChange: (level: PiThinkingLevel) => void;
}) {
  if (!options || !level || options.mode === 'none' || !options.levels.some((id) => id !== 'off')) return null;
  const label = (id: PiThinkingLevel) => {
    const value = options.labels[id] ?? id;
    return value.charAt(0).toUpperCase() + value.slice(1);
  };
  if (options.levels.length <= 1) return <span className="text-xs text-muted-foreground" title="This model requires thinking" data-testid="pi-thinking-required">{label(level)}</span>;
  return <TraitSelect title={options.mode === 'required' ? 'Thinking (required)' : 'Thinking'} selected={level}
    value={label(level)}
    items={options.levels.map((id) => ({ id, label: label(id), defaultValue: id === options.defaultLevel }))}
    onSelect={onChange} testId="pi-thinking-picker" />;
}
