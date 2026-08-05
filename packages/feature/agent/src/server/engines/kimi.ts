import { KIMI_DIR } from '@cockpit/shared-utils';
import { kimiApiKey } from './credentials';
import { makeAnthropicCompatSpec, type AnthropicCompatProvider } from './anthropicCompat';

// Kimi Code's Anthropic-compatible endpoint, driven by the Claude Agent SDK.
// https://www.kimi.com/code/docs/third-party-tools/claude-code.html
// Note the trailing slash: it is what the official docs publish, and the SDK appends
// `v1/messages` to it.
const KIMI_BASE_URL = 'https://api.kimi.com/coding/';
// Same key, same host, OpenAI protocol — used by Built-in Agent mode and by the
// model/quota routes.
export const KIMI_OPENAI_BASE_URL = 'https://api.kimi.com/coding/v1';
const DEFAULT_MODEL = 'kimi-for-coding';

/**
 * Context window per model, used only when settings hold no `modelContextTokens`
 * (a session created before the picker was ever opened). The live values come from
 * GET /coding/v1/models via the picker; these are the ids that endpoint reported at
 * the time of writing. Unknown ids fall back to the smaller window on purpose —
 * overrunning the real context costs a failed turn, under-using it costs nothing.
 */
const CONTEXT_TOKENS_FALLBACK: Record<string, number> = {
  k3: 1_048_576,
  'k3-256k': 262_144,
  'kimi-for-coding': 262_144,
  'kimi-for-coding-highspeed': 262_144,
};
const DEFAULT_CONTEXT_TOKENS = 262_144;

/**
 * `k3[1m]` is Kimi's Claude-Code-only notation for the 1M-context variant: the models
 * API lists the id as plain `k3`, but the Anthropic-compatible endpoint only opens the
 * full window when ANTHROPIC_MODEL carries the suffix. So the picker shows `k3`,
 * Built-in Agent mode (OpenAI protocol) sends `k3`, and only SDK mode rewrites it.
 * Do not "fix" this into a single id — the two protocols genuinely disagree.
 */
function kimiWireModel(model: string): string {
  return model === 'k3' ? 'k3[1m]' : model;
}

/** Exported for the env test — the values below are what actually ships. */
export const kimiProvider: AnthropicCompatProvider = {
  name: 'kimi',
  label: 'Kimi',
  endpoints: { anthropicBaseUrl: KIMI_BASE_URL, openAiBaseUrl: KIMI_OPENAI_BASE_URL },
  configDir: KIMI_DIR,
  defaultModel: DEFAULT_MODEL,
  apiKey: kimiApiKey,
  sdkWireModel: kimiWireModel,
  // Kimi's coding models are thinking-only and reject any temperature but 1 with
  // `invalid temperature: only 1 is allowed for this model`, which fails the turn before a
  // token streams. Omit the field and take the provider default.
  builtinTemperature: null,
  // Kimi Code publishes no small/fast tier — the official Claude Code config points every
  // model slot at the selected model, so ANTHROPIC_SMALL_FAST_MODEL falls through to it.
  // Both protocols list live models (GET /coding/v1/models), so unlike DeepSeek there is
  // nothing to whitelist against: pass the id through and let the API reject unknowns.
  resolveSdkModel(requested, saved) {
    if (typeof requested === 'string' && requested.trim()) return requested.trim();
    if (saved && saved.trim()) return saved.trim();
    return DEFAULT_MODEL;
  },
  sdkEnv(model, settings) {
    const wire = kimiWireModel(model);
    const contextTokens =
      settings.modelContextTokens ?? CONTEXT_TOKENS_FALLBACK[model] ?? DEFAULT_CONTEXT_TOKENS;
    return {
      // Kimi serves one model per key tier, so every alias the SDK may route to
      // (subagents, haiku-class helpers) has to resolve to the same id — otherwise the
      // SDK asks for `claude-3-5-haiku` and gets a 404.
      ANTHROPIC_DEFAULT_FABLE_MODEL: wire,
      ANTHROPIC_DEFAULT_OPUS_MODEL: wire,
      ANTHROPIC_DEFAULT_SONNET_MODEL: wire,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: wire,
      CLAUDE_CODE_SUBAGENT_MODEL: wire,
      // Without these the SDK compacts against Claude's default window and throws away
      // most of the 256K/1M context this plan pays for.
      CLAUDE_CODE_MAX_CONTEXT_TOKENS: String(contextTokens),
      CLAUDE_CODE_AUTO_COMPACT_WINDOW: String(contextTokens),
      ...(settings.modelEffort ? { CLAUDE_CODE_EFFORT_LEVEL: settings.modelEffort } : {}),
    };
  },
};

export const kimiSpec = makeAnthropicCompatSpec(kimiProvider);
