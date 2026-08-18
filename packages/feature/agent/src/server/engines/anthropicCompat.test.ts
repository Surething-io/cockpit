import { describe, it, expect } from 'vitest';
import { resolveEndpoints } from './anthropicCompat';
import { kimiProvider as kimi } from './kimi';
import { deepseekProvider as deepseek } from './deepseek';
import { glmProvider as glm } from './glm';

// These assert the SHIPPED provider configs, not a copy of them — a copy would keep
// passing after the real one regressed. Every mistake in here is silent at build time and
// only surfaces as a mid-turn HTTP failure.

describe('resolveEndpoints (multi-region providers)', () => {
  it('ships k3 as the Kimi fallback model', () => {
    expect(kimi.defaultModel).toBe('k3');
  });

  it('glm: English UI defaults to the international host, everything else to mainland', () => {
    expect(resolveEndpoints(glm, {}, 'en').openAiBaseUrl).toContain('api.z.ai');
    expect(resolveEndpoints(glm, {}, 'zh').openAiBaseUrl).toContain('open.bigmodel.cn');
    // 'auto' is resolved in the browser from navigator.language; the server cannot, so it
    // must land on a defined host rather than undefined.
    expect(resolveEndpoints(glm, {}, 'auto').openAiBaseUrl).toContain('open.bigmodel.cn');
    expect(resolveEndpoints(glm, {}, undefined).openAiBaseUrl).toContain('open.bigmodel.cn');
  });

  it('glm: an explicitly chosen region outranks the UI language', () => {
    // Language is a display preference — it seeds the default and nothing more, or changing
    // it would silently re-route live traffic to another country.
    expect(resolveEndpoints(glm, { region: 'cn' }, 'en').openAiBaseUrl).toContain('open.bigmodel.cn');
    expect(resolveEndpoints(glm, { region: 'global' }, 'zh').openAiBaseUrl).toContain('api.z.ai');
  });

  it('glm: an unknown saved region falls back instead of producing an undefined host', () => {
    expect(resolveEndpoints(glm, { region: 'moon' }, 'zh')).toEqual(glm.endpoints);
  });

  it('single-region providers ignore region entirely', () => {
    expect(resolveEndpoints(kimi, { region: 'global' }, 'en')).toEqual(kimi.endpoints);
    expect(resolveEndpoints(deepseek, { region: 'global' }, 'en')).toEqual(deepseek.endpoints);
  });

  it('every endpoint is the OpenAI-compatible one — the Anthropic SDK path is gone', () => {
    for (const p of [kimi, deepseek, glm]) {
      expect(p.endpoints.openAiBaseUrl.startsWith('https://')).toBe(true);
      expect(p.endpoints.openAiBaseUrl).not.toContain('/anthropic');
    }
  });
});
