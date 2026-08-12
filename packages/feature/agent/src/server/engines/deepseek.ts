import { deepseekApiKey } from './credentials';
import { makeAnthropicCompatSpec, type AnthropicCompatProvider } from './anthropicCompat';

// DeepSeek's OpenAI-compatible endpoint, driven by the Built-in Agent loop.
// Its /v1/models is the authoritative, live list, so nothing is whitelisted here: the
// picker offers whatever that endpoint reports and a model DeepSeek ships tomorrow works
// without a cockpit release.
const DEEPSEEK_OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
const DEFAULT_MODEL = 'deepseek-v4-pro';

/** Exported for the endpoint test — the values below are what actually ships. */
export const deepseekProvider: AnthropicCompatProvider = {
  name: 'deepseek',
  label: 'DeepSeek',
  endpoints: { openAiBaseUrl: DEEPSEEK_OPENAI_BASE_URL },
  defaultModel: DEFAULT_MODEL,
  apiKey: deepseekApiKey,
};

export const deepseekSpec = makeAnthropicCompatSpec(deepseekProvider);
