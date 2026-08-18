import { defaultRegionForLanguage } from '@cockpit/shared-utils';
import { glmApiKey } from './credentials';
import { makeAnthropicCompatSpec, type AnthropicCompatProvider, type EngineEndpoints } from './anthropicCompat';

/**
 * GLM (Zhipu / BigModel). https://docs.bigmodel.cn/cn/coding-plan/latest-model
 *
 * Served from two hosts: open.bigmodel.cn for mainland China and api.z.ai
 * internationally. They are the SAME account — a key issued on bigmodel.cn
 * authenticates on z.ai and reports identical quota (verified), so the region is
 * pure routing and switching it never orphans a session or invalidates a key.
 */
const GLM_REGIONS: Record<string, EngineEndpoints> = {
  cn: { openAiBaseUrl: 'https://open.bigmodel.cn/api/coding/paas/v4' },
  global: { openAiBaseUrl: 'https://api.z.ai/api/coding/paas/v4' },
};

/** Region ids, for the picker. Keep in sync with GLM_REGIONS. */
export const GLM_REGION_IDS = Object.keys(GLM_REGIONS);

const DEFAULT_MODEL = 'glm-5.3';

/** Exported for the endpoint test — the values below are what actually ships. */
export const glmProvider: AnthropicCompatProvider = {
  name: 'glm',
  label: 'GLM',
  endpoints: GLM_REGIONS.cn,
  regions: {
    byId: GLM_REGIONS,
    // Shared with the picker so the UI cannot claim one host while runs go to another.
    defaultFor: defaultRegionForLanguage,
  },
  defaultModel: DEFAULT_MODEL,
  apiKey: glmApiKey,
  // No builtinTemperature override: temperature 0 with tools is accepted here (verified),
  // unlike Kimi's thinking-only models.
};

export const glmSpec = makeAnthropicCompatSpec(glmProvider);
