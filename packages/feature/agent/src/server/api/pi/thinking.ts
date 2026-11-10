import { join } from 'node:path';
import { Effect } from 'effect';
import { AgentError, ValidationError } from '@cockpit/effect-core';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { isPiEngine, PI_AGENT_DIR } from '@cockpit/shared-utils';
import { resolvePiModel } from '../../../effect/piModelLive';
import { findPiSession, readPiSession } from '../../../effect/piSessionLive';
import { loadPiEngineConfig, piThinkingOptions, resolvePiThinking } from '../../../effect/piThinkingLive';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler((request) => Effect.gen(function* () {
  const query = new URL(request.url).searchParams;
  const engine = query.get('engine') ?? undefined;
  const modelId = query.get('model');
  if (!isPiEngine(engine) || !modelId) return yield* Effect.fail(new ValidationError({ field: 'model', reason: 'A Pi engine and model are required' }));
  const config = yield* loadPiEngineConfig(engine);
  const modelRuntime = yield* Effect.tryPromise({
    try: async () => {
      const { ModelRuntime } = await import('@earendil-works/pi-coding-agent');
      return ModelRuntime.create({ authPath: join(PI_AGENT_DIR, 'auth.json'), modelsPath: null, refreshOnCreate: false });
    },
    catch: (cause) => new AgentError({ provider: engine, kind: 'protocol', cause }),
  });
  const resolved = yield* resolvePiModel(modelRuntime, config, modelId);
  const options = yield* Effect.tryPromise({
    try: async () => {
      modelRuntime.registerProvider(engine, { baseUrl: config.baseUrl, api: 'openai-completions', models: [resolved.definition] });
      const model = modelRuntime.getModel(engine, modelId);
      if (!model) throw new Error(`Pi model unavailable: ${engine}/${modelId}`);
      return await piThinkingOptions(model, resolved.capabilities);
    },
    catch: (cause) => new AgentError({ provider: engine, kind: 'protocol', cause }),
  });
  const cwd = query.get('cwd');
  const sessionId = query.get('sessionId');
  const session = cwd && sessionId ? yield* findPiSession(cwd, sessionId) : undefined;
  const native = session?.engine === engine ? yield* readPiSession(session.path) : undefined;
  const saved = native?.entries.findLast((entry) => entry.type === 'thinking_level_change');
  return ok({ ...options, selectedLevel: resolvePiThinking(options, undefined, saved?.type === 'thinking_level_change' ? saved.thinkingLevel : undefined) });
}));
