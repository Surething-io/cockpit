// Shared effective model definitions for parent SDK and child CLI runtimes.
import { Effect } from 'effect';
import type { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { AgentError } from '@cockpit/effect-core';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { PI_MODEL_ALIASES, PI_MODEL_CAPABILITIES, PI_REQUEST_OUTPUT_BUDGET, type PiModelCapabilities, type PiChatDefinition, type PiModelOverride } from '../server/engines/shared/piModelCapabilities';
import { PI_AGENT_DIR, isPiEngine, resolveOllamaConnection } from '@cockpit/shared-utils';
import type { PiAgentConfig } from './piAgentLive';

export interface PiResolvedModel {
  definition: PiChatDefinition;
  capabilities: PiModelCapabilities;
  providerHeaders?: Record<string, string>;
}
interface ProviderOverrides {
  api?: string;
  baseUrl?: string;
  headers?: Record<string, string>;
  compat?: PiChatDefinition['compat'];
  models?: PiModelOverride[];
  modelOverrides?: Record<string, unknown>;
}
const PROVIDER_FIELDS = new Set(['api', 'baseUrl', 'headers', 'compat', 'models', 'modelOverrides']);
const MODEL_FIELDS = new Set(['type', 'id', 'api', 'baseUrl', 'name', 'reasoning', 'thinkingLevelMap', 'input', 'inputLimits', 'cost', 'promptCache', 'contextWindow', 'maxTokens', 'samplingParams', 'headers', 'compat']);
// Pi merges these directly into the wire payload. Keep request structure and
// length controls outside this explicitly supported sampling surface.
const SAMPLING_FIELDS = new Set(['temperature', 'top_p', 'top_k', 'min_p', 'frequency_penalty', 'presence_penalty', 'repetition_penalty', 'seed']);
const mergeCompat = (base: PiChatDefinition['compat'], override: PiChatDefinition['compat']): NonNullable<PiChatDefinition['compat']> => {
  const result = { ...base, ...override };
  const baseFields: Record<string, unknown> = { ...base };
  const overrideFields: Record<string, unknown> = { ...override };
  // Match Pi's nested compatibility merge rather than losing sibling settings.
  for (const key of ['openRouterRouting', 'vercelGatewayRouting', 'chatTemplateKwargs', 'chatTemplateArgs'] as const) {
    const previous = baseFields[key];
    const next = overrideFields[key];
    if ((typeof previous === 'object' && previous !== null) || (typeof next === 'object' && next !== null)) {
      Object.assign(result, { [key]: { ...(typeof previous === 'object' ? previous : {}), ...(typeof next === 'object' ? next : {}) } });
    }
  }
  return result;
};
const validLimit = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value > 0;

/** Resolve once per selected model. Children inherit the exact effective definition. */
export const resolvePiModel = (runtime: ModelRuntime, config: PiAgentConfig, id: string): Effect.Effect<PiResolvedModel, AgentError> => Effect.tryPromise({
  try: async (signal) => {
    const error = (detail: string) => new Error(`Model capabilities unavailable for ${config.engine}/${id}: ${detail}. Define this exact model in ${join(PI_AGENT_DIR, 'models.json')} (providers.${config.engine}.models).`);
    const raw = await readFile(join(PI_AGENT_DIR, 'models.json'), 'utf8').catch((cause: NodeJS.ErrnoException) => { if (cause.code === 'ENOENT') return '{}'; throw cause; });
    const overrides = JSON.parse(raw) as { providers?: Record<string, ProviderOverrides> };
    const provider = overrides.providers?.[config.engine];
    const validateFields = (value: object | undefined, allowed: Set<string>, label: string): void => {
      for (const key of Object.keys(value ?? {})) if (!allowed.has(key)) throw error(`unsupported ${label} field ${key}`);
    };
    validateFields(provider, PROVIDER_FIELDS, 'provider');
    if (provider?.api && provider.api !== 'openai-completions') throw error('managed providers require api=openai-completions');
    if (overrides.providers?.[config.engine]?.modelOverrides?.[id]) throw error('use a complete models entry instead of modelOverrides so parent and CLI limits cannot diverge');
    const explicit = config.modelDefinitions?.[id] ?? overrides.providers?.[config.engine]?.models?.find((m) => m.id === id);
    validateFields(explicit, MODEL_FIELDS, 'model');
    if (explicit?.samplingParams !== undefined && (explicit.samplingParams === null || typeof explicit.samplingParams !== 'object' || Array.isArray(explicit.samplingParams))) throw error('samplingParams must be an object of supported numeric fields');
    validateFields(explicit?.samplingParams, SAMPLING_FIELDS, 'sampling');
    for (const [field, value] of Object.entries(explicit?.samplingParams ?? {})) {
      if (typeof value !== 'number' || !Number.isFinite(value)) throw error(`sampling field ${field} must be a finite number`);
    }
    if (explicit?.type && explicit.type !== 'chat') throw error('only chat model definitions are supported');
    if (explicit?.api && explicit.api !== 'openai-completions') throw error('managed models require api=openai-completions');
    if (explicit?.baseUrl && explicit.baseUrl.replace(/\/$/, '') !== config.baseUrl.replace(/\/$/, '')) throw error('model baseUrl must match the Cockpit engine endpoint');
    if (config.engine === 'kimi' && explicit?.samplingParams) throw error('Kimi sampling overrides are unsupported; the service requires its fixed sampling contract');
    const validateHeaders = (headers: Record<string, string> | undefined): void => {
      for (const [name, value] of Object.entries(headers ?? {})) {
        if (typeof value !== 'string' || value.startsWith('!') || value.includes('$')) throw error(`header ${name} must be literal; command and environment interpolation are unsupported in managed runs`);
      }
      // Validate without echoing values, which may contain credentials.
      if (headers) {
        const valid = Effect.runSync(Effect.try(() => new Headers(headers)).pipe(Effect.option));
        if (valid._tag === 'None') throw error('invalid HTTP header names or values');
      }
    };
    validateHeaders(provider?.headers);
    validateHeaders(explicit?.headers);
    if (config.temperature === null && explicit?.samplingParams) throw error('sampling overrides conflict with the engine sampling policy');
    const canonical = PI_MODEL_ALIASES[config.engine]?.[id] ?? id;
    const catalog = { ollama: 'ollama', deepseek: 'deepseek', kimi: 'kimi-coding', glm: 'zai' }[config.engine];
    const native = runtime.getModel(catalog, canonical);
    let caps = PI_MODEL_CAPABILITIES[config.engine]?.[canonical];
    const request = async (url: string, body?: unknown): Promise<Record<string, unknown>> => {
      const response = await fetch(url, { method: body ? 'POST' : 'GET', headers: {
        Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', ...provider?.headers, ...explicit?.headers,
      }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.any([signal, AbortSignal.timeout(8000)]) });
      if (!response.ok) throw error(`metadata request returned HTTP ${response.status}`);
      return await response.json() as Record<string, unknown>;
    };
    if (config.engine === 'ollama' && !explicit) {
      const base = config.baseUrl.replace(/\/v1\/?$/, '');
      const info = await request(`${base}/api/show`, { model: id });
      const capabilities = Array.isArray(info.capabilities) ? info.capabilities : [];
      if (!capabilities.includes('completion')) throw error('this model does not report text completion support');
      if (!capabilities.includes('tools')) throw error('this model does not report tool support');
      const params = typeof info.parameters === 'string' ? info.parameters : '';
      const configured = Number(params.match(/(?:^|\n)num_ctx\s+(\d+)/)?.[1]);
      const loaded = await request(`${base}/api/ps`);
      const running = Array.isArray(loaded.models) ? loaded.models.find((m: { name?: string; model?: string }) => m.name === id || m.model === id) : undefined;
      const context = config.contextWindow ?? (validLimit(running?.context_length) ? running.context_length : configured);
      if (!validLimit(context)) throw error('effective num_ctx is unknown; model_info context_length alone is only a theoretical maximum');
      caps = { contextWindow: context, maxOutputTokens: null, input: capabilities.includes('vision') ? ['text', 'image'] : ['text'],
        tools: true, thinking: capabilities.includes('thinking') ? 'optional' : 'none', defaultThinking: 'off',
        compat: { maxTokensField: 'max_tokens', supportsStore: false, supportsDeveloperRole: false }, source: `${base}/api/show + /api/ps`, verifiedAt: 'runtime' };
    }
    if (!caps && native) caps = { contextWindow: native.contextWindow, maxOutputTokens: native.maxTokens, input: native.input,
      tools: true, thinking: native.reasoning ? 'optional' : 'none', defaultThinking: 'off',
      compat: native.api === 'openai-completions' ? native.compat ?? {} : {}, thinkingLevelMap: native.thinkingLevelMap,
      source: 'pi-coding-agent@1.4.0 model catalog', verifiedAt: '2026-11-02' };
    if (explicit) {
      if (!validLimit(explicit.contextWindow) || !validLimit(explicit.maxTokens) || (!Array.isArray(explicit.input) || !explicit.input.includes('text') || explicit.input.some((input) => !['text', 'image'].includes(input))) || typeof explicit.reasoning !== 'boolean') throw error('explicit definition needs contextWindow, maxTokens, input and reasoning');
      caps = { ...(caps ?? { tools: true, defaultThinking: 'off' }), source: 'explicit models.json', verifiedAt: 'operator',
        contextWindow: explicit.contextWindow, maxOutputTokens: explicit.maxTokens, input: explicit.input, thinking: caps?.thinking === 'required' ? 'required' : explicit.reasoning ? 'optional' : 'none',
        compat: caps?.compat ?? {}, thinkingLevelMap: explicit.thinkingLevelMap ?? caps?.thinkingLevelMap };
    }
    if (!caps) throw error('unknown model ID; no audited definition or native catalog entry');
    caps = { ...caps, compat: mergeCompat(mergeCompat(caps.compat, provider?.compat), explicit?.compat) };
    if (config.engine === 'kimi' && !explicit) {
      const metadata = await request(`${config.baseUrl.replace(/\/$/, '')}/models`);
      const model = Array.isArray(metadata.data) ? metadata.data.find((m: { id?: string }) => m.id === id) : undefined;
      if (!model) throw error('the configured Coding Plan endpoint did not list this model');
      if (validLimit(model.context_length)) caps = { ...caps, contextWindow: Math.min(caps.contextCeiling ?? caps.contextWindow, model.context_length) };
    }
    const contextWindow = config.contextWindow === undefined ? caps.contextWindow : Math.min(config.contextWindow, caps.contextWindow);
    if (!validLimit(contextWindow) || !validLimit(caps.maxOutputTokens ?? PI_REQUEST_OUTPUT_BUDGET) || !caps.tools) throw error('invalid limits or missing tool capability');
    if (caps.thinking === 'required' && !explicit?.reasoning && explicit) throw error('this service requires thinking mode');
    // Pi owns actual input accounting and compaction. Reserve at most half of
    // a small window for input when setting the configured output ceiling.
    const inputReserve = Math.min(4096, Math.ceil(contextWindow / 2));
    const requestedBudget = config.outputBudget ?? PI_REQUEST_OUTPUT_BUDGET;
    if (!validLimit(requestedBudget)) throw error('output budget must be a positive safe integer');
    const requestBudget = Math.min(requestedBudget, caps.maxOutputTokens ?? PI_REQUEST_OUTPUT_BUDGET, contextWindow - inputReserve);
    if (!validLimit(requestBudget)) throw error('output budget must be positive and fit the context window');
    caps = { ...caps, contextWindow };
    const definition: PiChatDefinition = { ...explicit, id, name: explicit?.name ?? id, reasoning: caps.thinking !== 'none', input: caps.input,
      contextWindow, maxTokens: requestBudget, compat: caps.compat, thinkingLevelMap: caps.thinkingLevelMap,
      inputLimits: explicit?.inputLimits ?? native?.inputLimits,
      headers: explicit?.headers ?? native?.headers,
      promptCache: explicit?.promptCache ?? native?.promptCache,
      cost: explicit?.cost ?? native?.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      ...(config.engine === 'kimi' || config.temperature === null ? {} : { samplingParams: { temperature: config.temperature ?? 0, ...explicit?.samplingParams } }),
    };
    return { definition, capabilities: caps, providerHeaders: provider?.headers };
  }, catch: (cause) => new AgentError({ provider: config.engine, kind: 'protocol', cause }),
});

/** Resolve an explicit provider/model using the same saved endpoints and credentials as chat. */
export const piChildSelection = (parent: PiAgentConfig, parentModel: string, requested?: string): Effect.Effect<{ config: PiAgentConfig; model: string }, AgentError> => Effect.tryPromise({
  try: async () => {
    if (!requested) return { config: parent, model: parentModel };
    const slash = requested.indexOf('/');
    const prefix = slash < 0 ? undefined : requested.slice(0, slash);
    const qualified = isPiEngine(prefix);
    const provider = qualified ? prefix : parent.engine;
    const model = qualified ? requested.slice(slash + 1) : requested;
    if (!isPiEngine(provider) || !model.trim()) throw new Error('Use a configured Pi provider/model, or a bare model ID');
    if (provider === parent.engine) return { config: parent, model };
    if (provider === 'ollama') {
      const connection = await resolveOllamaConnection();
      return { config: { engine: provider, baseUrl: `${connection.baseUrl}/v1`, apiKey: connection.apiKey || 'ollama' }, model };
    }
    const { readEngineEndpoints } = await import('../server/engines/anthropicCompat');
    const p = provider === 'deepseek' ? (await import('../server/engines/deepseek')).deepseekProvider
      : provider === 'kimi' ? (await import('../server/engines/kimi')).kimiProvider : (await import('../server/engines/glm')).glmProvider;
    const apiKey = await p.apiKey.read();
    if (!apiKey) throw new Error(`No API key configured for ${provider}`);
    return { config: { engine: provider, baseUrl: (await readEngineEndpoints(p)).openAiBaseUrl, apiKey, temperature: p.builtinTemperature }, model };
  },
  catch: (cause) => new AgentError({ provider: parent.engine, kind: 'protocol', cause }),
});
