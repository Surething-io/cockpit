import { describe, it, expect } from 'vitest';
import { buildEnv, resolveEndpoints } from './anthropicCompat';
import { kimiProvider as kimi } from './kimi';
import { deepseekProvider as deepseek } from './deepseek';
import { glmProvider as glm } from './glm';

/** buildEnv now takes the resolved endpoints; for single-region providers that is just theirs. */
const envFor = (
  provider: typeof kimi,
  apiKey: string,
  model: string,
  settings: Parameters<typeof buildEnv>[0]['settings'],
) => buildEnv({ provider, apiKey, model, settings, endpoints: resolveEndpoints(provider, settings, undefined) });

// The SDK is configured entirely through spawn env, and every mistake in here is silent:
// a wrong ANTHROPIC_MODEL only surfaces as a mid-turn 404, a missing context limit just
// compacts early and wastes the window the plan pays for. These assert the SHIPPED provider
// configs, not a copy of them — a copy would keep passing after the real one regressed.

describe('buildEnv (Anthropic-compatible engines)', () => {
  it('deletes ANTHROPIC_AUTH_TOKEN rather than blanking it — an empty Bearer header is a 401', () => {
    const env = envFor(deepseek, 'k', 'deepseek-v4-pro', {});
    expect('ANTHROPIC_AUTH_TOKEN' in env).toBe(false);
  });

  it('routes the key through ANTHROPIC_API_KEY (both providers read it as x-api-key)', () => {
    expect(envFor(kimi, 'sk-kimi-x', 'kimi-for-coding', {}).ANTHROPIC_API_KEY).toBe('sk-kimi-x');
  });

  it('isolates the SDK config dir from the user\'s real ~/.claude', () => {
    // Whatever COCKPIT_HOME resolves to, it must not be ~/.claude — that directory holds the
    // user's own Claude credentials and sessions.
    const dir = envFor(kimi, 'k', 'kimi-for-coding', {}).CLAUDE_CONFIG_DIR!;
    expect(dir.endsWith('/kimi')).toBe(true);
    expect(dir).not.toContain('/.claude');
  });

  it('kimi: rewrites k3 to the Claude-Code-only 1M notation on the wire', () => {
    const env = envFor(kimi, 'k', 'k3', { modelContextTokens: 1_048_576 });
    expect(env.ANTHROPIC_MODEL).toBe('k3[1m]');
    // Every alias the SDK may route to has to resolve to the same id — Kimi serves one.
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('k3[1m]');
    expect(env.ANTHROPIC_DEFAULT_HAIKU_MODEL).toBe('k3[1m]');
    expect(env.CLAUDE_CODE_SUBAGENT_MODEL).toBe('k3[1m]');
  });

  it('kimi: leaves non-k3 ids alone', () => {
    expect(envFor(kimi, 'k', 'k3-256k', {}).ANTHROPIC_MODEL).toBe('k3-256k');
  });

  it('kimi: takes the context window from the picked model, not a fixed default', () => {
    const env = envFor(kimi, 'k', 'k3', { modelContextTokens: 1_048_576, modelEffort: 'high' });
    expect(env.CLAUDE_CODE_MAX_CONTEXT_TOKENS).toBe('1048576');
    expect(env.CLAUDE_CODE_AUTO_COMPACT_WINDOW).toBe('1048576');
    expect(env.CLAUDE_CODE_EFFORT_LEVEL).toBe('high');
  });

  it('kimi: omits the effort level for models that do not support thinking efforts', () => {
    const env = envFor(kimi, 'k', 'kimi-for-coding', { modelContextTokens: 262_144 });
    expect('CLAUDE_CODE_EFFORT_LEVEL' in env).toBe(false);
  });

  it('deepseek: keeps its dedicated small/fast model and its server-side cache opt-out', () => {
    const env = envFor(deepseek, 'k', 'deepseek-v4-pro', {});
    expect(env.ANTHROPIC_SMALL_FAST_MODEL).toBe('deepseek-v4-flash');
    expect(env.DISABLE_PROMPT_CACHING).toBe('1');
  });

  it('deepseek: sets no context/effort env — those are kimi-specific', () => {
    const env = envFor(deepseek, 'k', 'deepseek-v4-pro', { modelContextTokens: 999 });
    expect('CLAUDE_CODE_MAX_CONTEXT_TOKENS' in env).toBe(false);
  });
});

describe('resolveEndpoints (multi-region providers)', () => {
  it('glm: English UI defaults to the international host, everything else to mainland', () => {
    expect(resolveEndpoints(glm, {}, 'en').anthropicBaseUrl).toContain('api.z.ai');
    expect(resolveEndpoints(glm, {}, 'zh').anthropicBaseUrl).toContain('open.bigmodel.cn');
    // 'auto' is resolved in the browser from navigator.language; the server cannot, so it
    // must land on a defined host rather than undefined.
    expect(resolveEndpoints(glm, {}, 'auto').anthropicBaseUrl).toContain('open.bigmodel.cn');
    expect(resolveEndpoints(glm, {}, undefined).anthropicBaseUrl).toContain('open.bigmodel.cn');
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
  });

  it('glm: both protocols move together — a mixed pair would send chat and models to different hosts', () => {
    for (const lang of ['en', 'zh']) {
      const e = resolveEndpoints(glm, {}, lang);
      expect(new URL(e.anthropicBaseUrl).host).toBe(new URL(e.openAiBaseUrl).host);
    }
  });
});
