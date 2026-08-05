import { GLM_DIR, defaultRegionForLanguage } from '@cockpit/shared-utils';
import { glmApiKey } from './credentials';
import { makeAnthropicCompatSpec, type AnthropicCompatProvider, type EngineEndpoints } from './anthropicCompat';

/**
 * GLM (Zhipu / BigModel). https://docs.bigmodel.cn/cn/coding-plan/latest-model
 *
 * Served from two hosts: open.bigmodel.cn for mainland China and api.z.ai
 * internationally. They are the SAME account — a key issued on bigmodel.cn
 * authenticates on z.ai and reports identical quota (verified), so the region is
 * pure routing and switching it never orphans a session or invalidates a key.
 *
 * Note the asymmetry in the two protocols' paths: the Anthropic-compatible one is
 * NOT under /coding (there is no /api/coding/anthropic — it 404s), while the
 * OpenAI-compatible one is.
 */
const GLM_REGIONS: Record<string, EngineEndpoints> = {
  cn: {
    anthropicBaseUrl: 'https://open.bigmodel.cn/api/anthropic',
    openAiBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  global: {
    anthropicBaseUrl: 'https://api.z.ai/api/anthropic',
    openAiBaseUrl: 'https://api.z.ai/api/coding/paas/v4',
  },
};

/** Region ids, for the picker. Keep in sync with GLM_REGIONS. */
export const GLM_REGION_IDS = Object.keys(GLM_REGIONS);

const DEFAULT_MODEL = 'glm-5.2';

/** Exported for the env test — the values below are what actually ships. */
export const glmProvider: AnthropicCompatProvider = {
  name: 'glm',
  label: 'GLM',
  endpoints: GLM_REGIONS.cn,
  regions: {
    byId: GLM_REGIONS,
    // Shared with the picker so the UI cannot claim one host while runs go to another.
    defaultFor: defaultRegionForLanguage,
  },
  configDir: GLM_DIR,
  defaultModel: DEFAULT_MODEL,
  apiKey: glmApiKey,
  // GLM's /models reports bare ids — no context window, no display name — so unlike Kimi
  // there is nothing to whitelist against and nothing to derive a context limit from.
  // Pass the id through and let the API reject unknowns.
  resolveSdkModel(requested, saved) {
    if (typeof requested === 'string' && requested.trim()) return requested.trim();
    if (saved && saved.trim()) return saved.trim();
    return DEFAULT_MODEL;
  },
  sdkEnv(model) {
    return {
      // GLM serves one model per request, so every alias the SDK may route to has to
      // resolve to the same id — otherwise it asks for `claude-3-5-haiku` and gets a 404.
      ANTHROPIC_DEFAULT_FABLE_MODEL: model,
      ANTHROPIC_DEFAULT_OPUS_MODEL: model,
      ANTHROPIC_DEFAULT_SONNET_MODEL: model,
      ANTHROPIC_DEFAULT_HAIKU_MODEL: model,
      CLAUDE_CODE_SUBAGENT_MODEL: model,
    };
  },
  // No CLAUDE_CODE_MAX_CONTEXT_TOKENS: GLM publishes no per-model context metadata, and a
  // hardcoded table would silently rot as models ship. The SDK default is close enough to
  // GLM's 200K that guessing is not worth the staleness.
  //
  // No builtinTemperature override either: temperature 0 with tools is accepted here
  // (verified), unlike Kimi's thinking-only models.
};

export const glmSpec = makeAnthropicCompatSpec(glmProvider);
