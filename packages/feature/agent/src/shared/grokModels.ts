export interface GrokModelOption {
  id: string;
  label: string;
  reasoning: Array<{ id: string; label: string }>;
  defaultReasoning?: string;
}

export interface GrokModelCatalog {
  models: GrokModelOption[];
  defaultModel: string;
}

export const GROK_DEFAULT_MODEL = 'grok-4.7';
export const GROK_DEFAULT_REASONING = 'high';

const GROK_REASONING = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
];

export const GROK_MODEL_CATALOG: GrokModelCatalog = {
  defaultModel: GROK_DEFAULT_MODEL,
  models: [
    { id: 'grok-4.7', label: 'Grok 4.7' },
    { id: 'grok-4.6', label: 'Grok 4.6' },
    { id: 'grok-4.5', label: 'Grok 4.5' },
  ].map((model) => ({ ...model, reasoning: GROK_REASONING, defaultReasoning: GROK_DEFAULT_REASONING })),
};
