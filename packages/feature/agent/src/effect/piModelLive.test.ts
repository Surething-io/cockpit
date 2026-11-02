import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { ModelRuntime } from '@earendil-works/pi-coding-agent';
import { PI_MODEL_CAPABILITIES } from '../server/engines/shared/piModelCapabilities';
import type { PiAgentConfig } from './piAgentLive';
let home: string, baseUrl: string, server: Server, runtime: ModelRuntime;
let resolvePiModel: typeof import('./piModelLive').resolvePiModel;
const oldHome = process.env.COCKPIT_HOME;
const calls: string[] = [];
beforeAll(async () => {
  home = await mkdtemp(join(tmpdir(), 'pi-model-contracts-')); process.env.COCKPIT_HOME = home;
  await mkdir(join(home, 'pi'));
  ({ resolvePiModel } = await import('./piModelLive'));
  runtime = await ModelRuntime.create({ authPath: join(home, 'pi', 'auth.json'), modelsPath: null, refreshOnCreate: false });
  server = createServer(async (req, res) => {
    calls.push(req.url!);
    if (req.headers.authorization !== 'Bearer local-only') { res.writeHead(401); res.end(); return; }
    res.setHeader('content-type', 'application/json');
    if (req.url === '/v1/models') {
      res.end(JSON.stringify({ data: Object.keys(PI_MODEL_CAPABILITIES.kimi!).map((id) => ({ id, context_length: id === 'k3' ? 262144 : 1048576 })) })); return;
    }
    if (req.url === '/api/show') {
      const chunks: Buffer[] = []; for await (const c of req) chunks.push(c);
      const { model } = JSON.parse(Buffer.concat(chunks).toString());
      res.end(JSON.stringify({ capabilities: model === 'embedding' ? ['embedding'] : ['completion', 'tools', 'vision'], model_info: { 'test.context_length': 131072 } })); return;
    }
    if (req.url === '/api/ps') { res.end(JSON.stringify({ models: [{ name: 'local-model', context_length: 8192 }] })); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address(); if (!addr || typeof addr === 'string') throw new Error('Missing test port');
  baseUrl = `http://127.0.0.1:${addr.port}/v1`;
});
afterAll(async () => {
  server?.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve()));
  await rm(home, { recursive: true, force: true });
  if (oldHome === undefined) delete process.env.COCKPIT_HOME; else process.env.COCKPIT_HOME = oldHome;
});
const resolveModel = (engine: PiAgentConfig['engine'], id: string, extra: Partial<PiAgentConfig> = {}) =>
  Effect.runPromise(resolvePiModel(runtime, { engine, baseUrl, apiKey: 'local-only', ...extra }, id).pipe(Effect.mapError((e) => e.cause)));

it('uses audited DeepSeek aliases without changing the wire ID, and separates limits from request budget', async () => {
  const model = await resolveModel('deepseek', 'deepseek-v4-flash');
  expect(model.definition).toMatchObject({ id: 'deepseek-v4-flash', contextWindow: 1000000, maxTokens: 32768, input: ['text', 'image'] });
  expect(model.capabilities.maxOutputTokens).toBe(384000);
  expect(model.definition.compat).toMatchObject({ maxTokensField: 'max_tokens', requiresReasoningContentOnAssistantMessages: true });
});
it('resolves every audited cloud model, including required thinking and service entitlements', async () => {
  for (const engine of ['deepseek', 'kimi', 'glm'] as const) {
    for (const id of Object.keys(PI_MODEL_CAPABILITIES[engine]!)) {
      const model = await resolveModel(engine, id);
      expect(model.definition.contextWindow).toBeGreaterThan(32768);
      expect(model.definition.maxTokens).toBeLessThanOrEqual(model.definition.contextWindow! - 4096);
      expect(model.capabilities.source).toMatch(/^https:/);
    }
  }
  expect((await resolveModel('kimi', 'k3')).definition.contextWindow).toBe(262144);
  expect((await resolveModel('kimi', 'k3-256k')).definition.contextWindow).toBe(262144);
  expect((await resolveModel('kimi', 'k3.1-pro')).definition.contextWindow).toBe(1048576);
  expect((await resolveModel('glm', 'glm-5.3')).capabilities).toMatchObject({ thinking: 'required', defaultThinking: 'low' });
  expect((await resolveModel('kimi', 'k3.1-pro')).definition).not.toHaveProperty('samplingParams');
});
it('rejects unknown IDs instead of guessing from the name or using 32K/4K defaults', async () => {
  const count = calls.length;
  await expect(resolveModel('deepseek', 'deepseek-v99-flash')).rejects.toThrow('Model capabilities unavailable');
  expect(calls.length).toBe(count);
});
it('uses effective Ollama runtime context rather than theoretical context, and rejects embedding-only/unknown runtime models', async () => {
  expect((await resolveModel('ollama', 'local-model')).definition).toMatchObject({ contextWindow: 8192, maxTokens: 4096, input: ['text', 'image'] });
  await expect(resolveModel('ollama', 'embedding')).rejects.toThrow();
  await expect(resolveModel('ollama', 'not-loaded')).rejects.toThrow();
});
it('accepts complete native overrides, validates limits, and honors explicit output budgets', async () => {
  const model = { id: 'private-model', contextWindow: 262144, maxTokens: 65536, input: ['text'] as ['text'], reasoning: false };
  await writeFile(join(home, 'pi', 'models.json'), JSON.stringify({ providers: { deepseek: { api: 'openai-completions', models: [model] } } }));
  const resolved = await resolveModel('deepseek', 'private-model', { outputBudget: 8192 });
  expect(resolved.definition).toMatchObject({ contextWindow: 262144, maxTokens: 8192 });
  expect(resolved.capabilities.maxOutputTokens).toBe(65536);
  await expect(resolveModel('deepseek', 'private-model', { outputBudget: 0 })).rejects.toThrow();
  await expect(resolveModel('glm', 'glm-5.3', { modelDefinitions: { 'glm-5.3': { ...model, id: 'glm-5.3', reasoning: false } } })).rejects.toThrow('requires thinking');
  await expect(resolveModel('deepseek', 'bad', { modelDefinitions: { bad: { ...model, maxTokens: -1 } } })).rejects.toThrow();
});

it('rejects top-layer native modelOverrides that could override the managed CLI definition', async () => {
  await writeFile(join(home, 'pi', 'models.json'), JSON.stringify({ providers: { deepseek: { modelOverrides: { 'deepseek-flash': { contextWindow: 32768 } } } } }));
  await expect(resolveModel('deepseek', 'deepseek-flash')).rejects.toThrow('modelOverrides');
});

it('preserves provider and model request headers and rejects unsupported configuration instead of dropping it', async () => {
  const model = { id: 'header-model', contextWindow: 262144, maxTokens: 65536, input: ['text'], reasoning: false,
    headers: { 'X-Tenant': 'model-tenant' }, compat: { chatTemplateKwargs: { shared: 'model', model_flag: true } }, samplingParams: { top_p: 0.8 }, promptCache: { short: 42 } };
  const write = async (provider: object) => writeFile(join(home, 'pi', 'models.json'), JSON.stringify({ providers: { deepseek: provider } }));
  await write({ api: 'openai-completions', models: [model], compat: { chatTemplateKwargs: { shared: 'provider', provider_flag: true } }, headers: { 'X-Tenant': 'provider-tenant', 'X-Route': 'private' } });
  const result = await resolveModel('deepseek', model.id);
  expect(result.providerHeaders).toEqual({ 'X-Tenant': 'provider-tenant', 'X-Route': 'private' });
  expect(result.definition.headers).toEqual({ 'X-Tenant': 'model-tenant' });
  expect(result.definition.samplingParams).toMatchObject({ top_p: 0.8 });
  expect(result.definition.promptCache).toEqual({ short: 42 });
  expect(result.definition.compat).toMatchObject({ chatTemplateKwargs: { shared: 'model', model_flag: true, provider_flag: true } });
  await write({ models: [{ ...model, headers: { 'X-Tenant': '$TENANT' } }] });
  await expect(resolveModel('deepseek', model.id)).rejects.toThrow('must be literal');
  await write({ models: [model], oauth: 'provider-specific' });
  await expect(resolveModel('deepseek', model.id)).rejects.toThrow('unsupported provider field oauth');
  await write({ models: [{ ...model, unsupportedField: true }] });
  await expect(resolveModel('deepseek', model.id)).rejects.toThrow('unsupported model field');
});

it.each([1024, 4095, 4096, 4097, 8192])('accepts a complete small-window model with an explicit budget: %s', async (contextWindow) => {
  const id = 'small-model';
  const result = await resolveModel('ollama', id, { outputBudget: 512,
    modelDefinitions: { [id]: { id, contextWindow, maxTokens: 1024, reasoning: false, input: ['text'] } } });
  expect(result.definition.maxTokens).toBe(512);
  expect(result.definition.contextWindow).toBe(contextWindow);
});
it('preserves namespaced bare model IDs and strips only known provider prefixes', async () => {
  const { piChildSelection } = await import('./piModelLive');
  const config: PiAgentConfig = { engine: 'ollama', baseUrl, apiKey: 'local-only' };
  for (const [requested, model] of [['namespace/model', 'namespace/model'], ['ollama/namespace/model', 'namespace/model'], ['model', 'model']] as const) {
    expect(await Effect.runPromise(piChildSelection(config, 'parent', requested))).toEqual({ config, model });
  }
  await expect(Effect.runPromise(piChildSelection(config, 'parent', 'ollama/'))).rejects.toThrow();
});

it.each([0, -1, NaN, Infinity, 1.5])('rejects invalid explicit output budgets before making a request: %s', async (outputBudget) => {
  await expect(resolveModel('ollama', 'valid-model', { outputBudget, modelDefinitions: {
    'valid-model': { id: 'valid-model', contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ['text'] },
  } })).rejects.toThrow('positive safe integer');
});

it.each(['max_tokens', 'max_completion_tokens', 'max_output_tokens', 'messages', 'model', 'unknown_parameter'])('rejects non-sampling ownership in samplingParams: %s', async (field) => {
  await expect(resolveModel('ollama', 'sampling-model', { modelDefinitions: {
    'sampling-model': { id: 'sampling-model', contextWindow: 4096, maxTokens: 1024, reasoning: false, input: ['text'], samplingParams: { [field]: 99999 } },
  }, outputBudget: 512 })).rejects.toThrow('unsupported sampling field');
});

it.each([null, 42, [], { top_p: '0.8' }, { temperature: NaN }, { seed: Infinity }])('rejects malformed or nonfinite sampling configuration: %j', async (samplingParams) => {
  const path = join(home, 'pi', 'models.json');
  const original = await (await import('node:fs/promises')).readFile(path, 'utf8');
  try {
    await writeFile(path, JSON.stringify({ providers: { ollama: { models: [{ id: 'invalid-sampling', contextWindow: 4096, maxTokens: 1024, input: ['text'], reasoning: false, samplingParams }] } } }));
    await expect(resolveModel('ollama', 'invalid-sampling')).rejects.toThrow(/sampling/);
  } finally { await writeFile(path, original); }
});
