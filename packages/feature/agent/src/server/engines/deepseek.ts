import { DEEPSEEK_DIR } from '@cockpit/shared-utils';
import { deepseekApiKey } from './credentials';
import { makeAnthropicCompatSpec, type AnthropicCompatProvider } from './anthropicCompat';

// DeepSeek's Anthropic-compatible endpoint. https://api-docs.deepseek.com/zh-cn/guides/anthropic_api
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEFAULT_MODEL = 'deepseek-v4-pro';
// Used by the SDK for fast/small subtasks (title gen, compaction).
const SMALL_FAST_MODEL = 'deepseek-v4-flash';
const ALLOWED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

// Built-in Agent mode talks to the OpenAI-compatible endpoint instead. Its /v1/models
// currently reports the SAME ids as ALLOWED_MODELS above, but it is the authoritative,
// live list (the Anthropic-compatible endpoint has no listing API), so that mode takes
// whatever the picker read from GET /api/deepseek/models rather than re-checking a
// hardcoded set — a model DeepSeek ships tomorrow works without a cockpit release.
const DEEPSEEK_OPENAI_BASE_URL = 'https://api.deepseek.com/v1';

/** Exported for the env test — the values below are what actually ships. */
export const deepseekProvider: AnthropicCompatProvider = {
  name: 'deepseek',
  label: 'DeepSeek',
  anthropicBaseUrl: DEEPSEEK_BASE_URL,
  openAiBaseUrl: DEEPSEEK_OPENAI_BASE_URL,
  configDir: DEEPSEEK_DIR,
  defaultModel: DEFAULT_MODEL,
  apiKey: deepseekApiKey,
  smallFastModel: SMALL_FAST_MODEL,
  disablePromptCaching: true, // DeepSeek runs its own server-side prefix KV cache
  // SDK mode is whitelist-gated: with no listing API to validate against, an unknown id
  // would only fail at the first chat turn.
  resolveSdkModel(requested, saved) {
    if (typeof requested === 'string' && ALLOWED_MODELS.has(requested)) return requested;
    if (saved && ALLOWED_MODELS.has(saved)) return saved;
    return DEFAULT_MODEL;
  },
};

export const deepseekSpec = makeAnthropicCompatSpec(deepseekProvider);
