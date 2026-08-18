import { kimiApiKey } from './credentials';
import { makeAnthropicCompatSpec, type AnthropicCompatProvider } from './anthropicCompat';

// Kimi Code's OpenAI-compatible endpoint — used by the chat loop and by the model/quota
// routes. https://www.kimi.com/code/docs
export const KIMI_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_MODEL = 'k3';

/** Exported for the endpoint test — the values below are what actually ships. */
export const kimiProvider: AnthropicCompatProvider = {
  name: 'kimi',
  label: 'Kimi',
  endpoints: { openAiBaseUrl: KIMI_OPENAI_BASE_URL },
  defaultModel: DEFAULT_MODEL,
  apiKey: kimiApiKey,
  // Kimi's coding models are thinking-only and reject any temperature but 1 with
  // `invalid temperature: only 1 is allowed for this model`, which fails the turn before a
  // token streams. Omit the field and take the provider default.
  builtinTemperature: null,
};

export const kimiSpec = makeAnthropicCompatSpec(kimiProvider);
