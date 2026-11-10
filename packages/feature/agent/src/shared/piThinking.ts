export const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'] as const;
export type PiThinkingLevel = typeof PI_THINKING_LEVELS[number];

export interface PiThinkingOptions {
  mode: 'optional' | 'required' | 'none';
  levels: PiThinkingLevel[];
  defaultLevel: PiThinkingLevel;
  selectedLevel: PiThinkingLevel;
  labels: Partial<Record<PiThinkingLevel, string>>;
}
