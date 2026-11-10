import { describe, expect, it } from 'vitest';
import type { Api, Model } from '@earendil-works/pi-ai';
import { PI_MODEL_CAPABILITIES, type PiModelCapabilities } from '../server/engines/shared/piModelCapabilities';
import { ollamaThinkingControls, piThinkingOptions, resolvePiThinking } from './piThinkingLive';

const optionsFor = (caps: PiModelCapabilities) => piThinkingOptions({ reasoning: caps.thinking !== 'none', thinkingLevelMap: caps.thinkingLevelMap } as Model<Api>, caps);

describe('per-model Pi thinking controls', () => {
  it.each([
    ['deepseek', 'deepseek-flash', ['off', 'low', 'high', 'max']],
    ['deepseek', 'deepseek-v4-pro', ['off', 'low', 'high', 'max']],
    ['kimi', 'k3.1-pro', ['low', 'high', 'max']],
    ['kimi', 'kimi-for-coding-highspeed', ['high']],
    ['glm', 'glm-4.7', ['off', 'high']],
    ['glm', 'glm-5.2', ['off', 'high', 'max']],
    ['glm', 'glm-5.3', ['low', 'high', 'max']],
    ['glm', 'glm-5.3-flash', ['low', 'high', 'max']],
  ] as const)('%s/%s exposes only its distinct controls', async (engine, model, expected) => {
    const options = await optionsFor(PI_MODEL_CAPABILITIES[engine]![model]);
    expect(options.levels).toEqual(expected);
    expect(options.levels).toContain(options.defaultLevel);
    expect(options.defaultLevel).toBe('high');
  });

  it('restores valid native settings and rejects unsupported requests, including forced-thinking Off', async () => {
    const options = await optionsFor(PI_MODEL_CAPABILITIES.glm!['glm-5.3']);
    expect(resolvePiThinking(options, undefined, 'max')).toBe('max');
    expect(resolvePiThinking(options, undefined, 'off')).toBe('high');
    for (const invalid of ['off', 'medium', 'unknown', null, true]) expect(() => resolvePiThinking(options, invalid)).toThrow('Unsupported');
  });

  it('labels boolean controls as Off/On', async () => {
    expect((await optionsFor(PI_MODEL_CAPABILITIES.glm!['glm-4.7'])).labels).toEqual({ off: 'Off', high: 'On' });
    expect((await optionsFor(PI_MODEL_CAPABILITIES.kimi!['kimi-for-coding-highspeed'])).labels).toEqual({ high: 'On' });
  });

  it.each([
    [{ thinking: { values: [false, true], default: true } }, ['off', 'high'], 'high', 'optional'],
    [{ thinking: { values: ['low', 'medium', 'high'], default: 'medium' } }, ['low', 'medium', 'high'], 'high', 'required'],
    [{ thinking: { values: [false] } }, ['off'], 'off', 'none'],
    [{}, ['off', 'high'], 'high', 'optional'],
  ] as const)('uses Ollama metadata without invented effort levels: %j', async (info, levels, defaultLevel, mode) => {
    const caps = { ...PI_MODEL_CAPABILITIES.deepseek!['deepseek-flash'], ...ollamaThinkingControls(info, true) };
    const options = await optionsFor(caps);
    expect(options).toMatchObject({ levels, defaultLevel, mode });
    if (options.levels.includes('off')) expect(caps.thinkingLevelMap!.off).toBe('none');
  });

  it('preserves model-defined Ollama names through the SDK mapping and labels', async () => {
    const caps = { ...PI_MODEL_CAPABILITIES.deepseek!['deepseek-flash'], ...ollamaThinkingControls({ thinking: { values: [false, 'quick', 'deep'], default: 'deep' } }, true) };
    const options = await optionsFor(caps);
    expect(Object.values(options.labels)).toEqual(['Off', 'quick', 'deep']);
    expect(options.labels[options.defaultLevel]).toBe('deep');
    expect(caps.thinkingLevelMap![options.defaultLevel]).toBe('deep');
  });
});
