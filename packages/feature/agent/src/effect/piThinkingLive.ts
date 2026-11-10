import { Effect } from 'effect';
import type { Api, Model } from '@earendil-works/pi-ai';
import { AgentError } from '@cockpit/effect-core';
import { resolveOllamaConnection, type PiEngine } from '@cockpit/shared-utils';
import type { PiAgentConfig } from './piAgentLive';
import type { PiModelCapabilities } from '../server/engines/shared/piModelCapabilities';
import { PI_THINKING_LEVELS, type PiThinkingLevel, type PiThinkingOptions } from '../shared/piThinking';

/** Use the SDK's model map and the service's required-thinking contract together. */
export async function piThinkingOptions(model: Model<Api>, caps: PiModelCapabilities): Promise<PiThinkingOptions> {
  const { getSupportedThinkingLevels } = await import('@earendil-works/pi-ai');
  const supported = getSupportedThinkingLevels(model);
  const levels = supported.filter((level) => caps.thinking !== 'required' || level !== 'off');
  if (!levels.length) throw new Error('This model requires thinking but defines no enabled thinking levels');
  const defaultLevel = levels.includes(caps.defaultThinking) ? caps.defaultThinking : levels[0] ?? 'off';
  const booleanOnly = levels.filter((level) => level !== 'off').length === 1;
  const labels = Object.fromEntries(levels.map((level) => [level, level === 'off' ? 'Off' : booleanOnly ? 'On' : model.thinkingLevelMap?.[level] ?? level]));
  return { mode: caps.thinking, levels, defaultLevel, selectedLevel: defaultLevel, labels };
}

/** Modern Ollama advertises exact controls; older versions advertise a boolean capability. */
export function ollamaThinkingControls(info: Record<string, unknown>, capable: boolean): Pick<PiModelCapabilities, 'thinking' | 'defaultThinking' | 'thinkingLevelMap'> {
  const metadata = info.thinking as { values?: unknown[]; default?: unknown } | undefined;
  const values = Array.isArray(metadata?.values) ? metadata.values : capable ? [false, true] : [false];
  const map: NonNullable<PiModelCapabilities['thinkingLevelMap']> = Object.fromEntries(PI_THINKING_LEVELS.map((level) => [level, null]));
  const slots = new Map<unknown, PiThinkingLevel>();
  // Reserve exact SDK names before allocating slots for model-defined names.
  for (const value of values) {
    if (value === false || value === 'none' || value === 'off') { map.off = 'none'; slots.set(value, 'off'); }
    else if (typeof value === 'string' && PI_THINKING_LEVELS.includes(value as PiThinkingLevel)) { map[value as PiThinkingLevel] = value; slots.set(value, value as PiThinkingLevel); }
  }
  for (const value of values) {
    if (slots.has(value)) continue;
    if (value !== true && typeof value !== 'string') continue;
    const slot = value === true && map.high === null ? 'high' : PI_THINKING_LEVELS.find((level) => level !== 'off' && map[level] === null);
    if (!slot) throw new Error('Ollama reports more thinking levels than Pi can represent');
    map[slot] = value === true ? 'high' : value as string;
    slots.set(value, slot);
  }
  const enabled = [...slots.values()].filter((level) => level !== 'off');
  const defaultThinking = slots.get('high') ?? slots.get(true) ?? slots.get(metadata?.default) ?? (map.off !== null ? 'off' : enabled[0] ?? 'off');
  return { thinking: enabled.length === 0 ? 'none' : map.off === null ? 'required' : 'optional', defaultThinking, thinkingLevelMap: map };
}

export function resolvePiThinking(options: PiThinkingOptions, requested: unknown, saved?: string): PiThinkingLevel {
  if (requested !== undefined) {
    if (!options.levels.includes(requested as PiThinkingLevel)) throw new Error(`Unsupported Pi thinking level: ${String(requested)}`);
    return requested as PiThinkingLevel;
  }
  return options.levels.includes(saved as PiThinkingLevel) ? saved as PiThinkingLevel : options.defaultLevel;
}

/** Chat and model controls read the same configured endpoints and credentials. */
export const loadPiEngineConfig = (engine: PiEngine): Effect.Effect<PiAgentConfig, AgentError> => Effect.tryPromise({
  try: async () => {
    if (engine === 'ollama') {
      const connection = await resolveOllamaConnection();
      return { engine, baseUrl: `${connection.baseUrl}/v1`, apiKey: connection.apiKey || 'ollama' };
    }
    const { readEngineEndpoints } = await import('../server/engines/anthropicCompat');
    const provider = engine === 'deepseek' ? (await import('../server/engines/deepseek')).deepseekProvider
      : engine === 'kimi' ? (await import('../server/engines/kimi')).kimiProvider : (await import('../server/engines/glm')).glmProvider;
    const apiKey = await provider.apiKey.read();
    if (!apiKey) throw new Error(`No API key configured for ${engine}`);
    return { engine, baseUrl: (await readEngineEndpoints(provider)).openAiBaseUrl, apiKey, temperature: provider.builtinTemperature };
  },
  catch: (cause) => new AgentError({ provider: engine, kind: 'protocol', cause }),
});
