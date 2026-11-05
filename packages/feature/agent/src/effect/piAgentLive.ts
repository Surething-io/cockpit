// Scoped Pi SDK integration; Pi owns tools, persistence, compaction and retries.
import { Effect, Option } from 'effect';
import { join } from 'node:path';
import { existsSync, writeFileSync } from 'node:fs';
import type { SessionManager, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { AgentError } from '@cockpit/effect-core';
import type { ImageContent } from '@earendil-works/pi-ai';
import { getPiSessionsDir, PI_AGENT_DIR, sanitizedSpawnEnv, type PiEngine } from '@cockpit/shared-utils';
import type { RunCtx } from '../server/engines/types';
import { piRunEvents, createPiRunUsage } from '../server/engines/piEvents';
import { makePiRunInput } from './piRunInputLive';
import { findPiSession } from './piSessionLive';
import { openPiSessionForWrite } from './piSessionWriteLive';
import type { PiModelOverride } from '../server/engines/shared/piModelCapabilities';
import { resolvePiModel } from './piModelLive';
import { makePiSubagentExtension } from './piSubagentLive';

export interface PiAgentConfig {
  engine: PiEngine;
  baseUrl: string;
  apiKey: string;
  temperature?: number | null;
  contextWindow?: number;
  outputBudget?: number;
  modelDefinitions?: Record<string, PiModelOverride>;
}

const piImages = (images: RunCtx['images']): ImageContent[] | undefined =>
  images?.map((image) => ({ type: 'image', data: image.data, mimeType: image.media_type }));

/** Run one turn with resources released when the Effect scope closes. */
export const runPiAgent = (ctx: RunCtx, config: PiAgentConfig): Effect.Effect<void, AgentError> => {
  const sdk = <A>(run: () => Promise<A>): Effect.Effect<A, AgentError> => Effect.tryPromise({
    try: run, catch: (cause) => new AgentError({ provider: config.engine, kind: 'protocol', cause }),
  });
  return Effect.scoped(Effect.gen(function* () {
    const cwd = ctx.cwd || process.cwd();
    let sessionManager: SessionManager | undefined;
    const inputs = yield* makePiRunInput(ctx, (pending) => Effect.gen(function* () {
      const reason = ctx.signal.aborted ? 'the run was cancelled' : 'the run failed';
      const text = `Input did not complete because ${reason}:\n${pending.map((input) => input.text || '[image input]').join('\n')}`;
      yield* Effect.sync(() => ctx.emit({ type: 'error', error: text }));
      if (sessionManager) yield* Effect.try({
        try: () => {
          const manager = sessionManager!;
          manager.appendCustomEntry('cockpit.undelivered-input', { text, inputs: pending, reason: ctx.signal.aborted ? 'cancelled' : 'failed' });
          // Pi deliberately defers new-file creation until a conversation message.
          // At scope teardown no SDK writer remains: retain the native header and
          // entries even if initialization never reached the first user message.
          const path = manager.getSessionFile();
          if (path && !existsSync(path)) {
            writeFileSync(path, [manager.getHeader(), ...manager.getEntries()].map((entry) => JSON.stringify(entry)).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
          }
        },
        catch: (cause) => new AgentError({ provider: config.engine, kind: 'protocol', cause }),
      }).pipe(Effect.catchAll((error) => Effect.logWarning('Cannot persist undelivered Pi input', error)));
    }));
    const usage = createPiRunUsage();
    const existing = ctx.sessionId ? yield* findPiSession(cwd, ctx.sessionId).pipe(Effect.mapError((cause) => new AgentError({ provider: config.engine, kind: 'session-not-found', cause }))) : undefined;
    if (ctx.sessionId && !existing) return yield* Effect.fail(new AgentError({ provider: config.engine, kind: 'session-not-found', cause: new Error('Pi session not found') }));
    const modelId = String(ctx.params.model);
    const startedAt = Date.now();
    const { session } = yield* Effect.acquireRelease(sdk(async () => {
      const { createAgentSession, createBashToolDefinition, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager } = await import('@earendil-works/pi-coding-agent');
      const manager = existing ? await Effect.runPromise(openPiSessionForWrite(existing.path)) : SessionManager.create(cwd, getPiSessionsDir(cwd), { id: ctx.params.newSessionId ?? ctx.currentKey() });
      sessionManager = manager;
      const runtime = await ModelRuntime.create({ authPath: join(PI_AGENT_DIR, 'auth.json'), modelsPath: null, refreshOnCreate: false });
      const resolution = await Effect.runPromise(Effect.either(resolvePiModel(runtime, config, modelId)), { signal: ctx.signal });
      if (resolution._tag === 'Left') throw resolution.left.cause;
      const resolved = resolution.right;
      runtime.registerProvider(config.engine, {
        baseUrl: config.baseUrl, api: 'openai-completions',
        models: [resolved.definition], headers: resolved.providerHeaders,
      });
      await runtime.setRuntimeApiKey(config.engine, config.apiKey);
      const model = runtime.getModel(config.engine, modelId);
      if (!model) throw new Error(`Pi model unavailable: ${config.engine}/${modelId}`);
      if (ctx.images?.length && !model.input.includes('image')) throw new Error(`Model ${modelId} does not support images`);
      const settings = SettingsManager.inMemory({ compaction: { enabled: ctx.params.noHistory !== true }, retry: { enabled: true, maxRetries: 2 } });
      const subagents = await Effect.runPromise(makePiSubagentExtension(config, runtime, modelId, ctx.signal, manager.getSessionId(), manager.getSessionFile()!, resolved));
      const resources = new DefaultResourceLoader({
        cwd, agentDir: PI_AGENT_DIR, settingsManager: settings,
        noExtensions: true, noPromptTemplates: true, noThemes: true,
        appendSystemPrompt: ["Reply in the user's language. End completed tasks with a concise response.", 'Prefer the subagent tool for independent Pi work so results and native child history are managed.', ...(ctx.outputStyle ? [ctx.outputStyle] : [])],
        extensionFactories: [subagents, (pi) => {
          if (ctx.params.noHistory) pi.on('context', (event) => ({ messages: event.messages.filter((m) => m.role === 'system' || m.timestamp >= startedAt) }));
          if (config.engine === 'ollama') pi.on('before_provider_request', (event) => {
            // Ollama endpoints may reject Pi's OpenAI null-content tool messages.
            // Normalize only the wire payload; native history remains unchanged.
            const payload = event.payload as { messages?: Array<{ content?: unknown }> } | null;
            if (!payload || !Array.isArray(payload.messages)) return;
            return { ...payload, messages: payload.messages.map((message) => message.content === null ? { ...message, content: '' } : message) };
          });
        }],
      });
      await resources.reload();
      const selection = manager.buildSessionContext().model;
      const created = await createAgentSession({ cwd, agentDir: PI_AGENT_DIR, modelRuntime: runtime, model,
        sessionManager: manager, settingsManager: settings, resourceLoader: resources,
        thinkingLevel: resolved.capabilities.defaultThinking,
        tools: ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls', 'subagent'],
        // The SDK erases tool schema generics at its registry boundary.
        customTools: [createBashToolDefinition(cwd, { spawnHook: (spawn) => ({ ...spawn, env: sanitizedSpawnEnv({ COCKPIT_RUN_ID: manager.getSessionId(), COCKPIT_CWD: cwd }, spawn.env) }) }) as unknown as ToolDefinition],
      });
      if (selection && (selection.provider !== model.provider || selection.modelId !== model.id)) await created.session.setModel(model);
      return created;
    }), ({ session }) => Effect.sync(() => session.dispose()));
    yield* sdk(() => session.bindExtensions({}));
    ctx.rekey(session.sessionManager.getSessionId());
    ctx.emit({ type: 'system', subtype: 'init', session_id: session.sessionManager.getSessionId() });
    yield* Effect.acquireRelease(Effect.sync(() => session.subscribe((event) => {
      for (const output of piRunEvents(event, cwd)) ctx.emit(output);
      if (event.type === 'message_end' && event.message.role === 'assistant') {
        const update = usage.record(event.message);
        if (update) ctx.emit(update);
      }
    })), (unsubscribe) => Effect.sync(unsubscribe));
    // The scoped fiber owns abort and queued input failures; no detached promises.
    yield* Effect.forkScoped(Effect.async<void>((resume) => {
      const stop = () => resume(Effect.void);
      ctx.signal.addEventListener('abort', stop, { once: true });
      if (ctx.signal.aborted) stop();
      return Effect.sync(() => ctx.signal.removeEventListener('abort', stop));
    }).pipe(Effect.andThen(sdk(() => session.abort()))));
    let next = yield* inputs.next;
    while (Option.isSome(next)) {
      if (ctx.signal.aborted) return;
      const input = next.value;
      if (input.images?.length && !session.model?.input.includes('image')) {
        return yield* Effect.fail(new AgentError({ provider: config.engine, kind: 'protocol', cause: new Error(`Model ${modelId} does not support images`) }));
      }
      // Cockpit owns the only input queue. Each prompt starts against an idle Pi
      // session, including inputs accepted while Pi was emitting agent_settled.
      yield* sdk(() => session.prompt(input.text ?? '', { images: piImages(input.images) }));
      yield* sdk(() => session.waitForIdle());
      if (ctx.signal.aborted) return;
      // Pi may omit a failed recovery from model context. Read the native journal,
      // otherwise a final length stop disappears and this run reports success.
      const entry = session.sessionManager.getBranch().findLast((e) => e.type === 'message' && e.message.role === 'assistant');
      const last = entry?.type === 'message' && entry.message.role === 'assistant' ? entry.message : undefined;
      if (last && last.stopReason !== 'stop') {
        return yield* Effect.fail(new AgentError({ provider: config.engine, kind: 'protocol', cause: new Error(last.errorMessage ?? `Pi response incomplete (stopReason=${last.stopReason}).${session.sessionManager.getBranch().some((e) => e.type === 'context_edit' && e.targetId === entry?.id && e.replacement === null) ? ' Pi excluded this response from subsequent model context.' : ''} Partial output is retained in history.`) }));
      }
      yield* inputs.complete;
      next = yield* inputs.next;
    }
    if (ctx.signal.aborted) return;
    ctx.emit({ type: 'result', subtype: 'success', usage: usage.snapshot(), total_cost_usd: usage.cost() });
  })).pipe(Effect.catchAll((error) => ctx.signal.aborted ? Effect.void : Effect.fail(error)), Effect.withSpan('agent.pi.run'));
};

/** Preserve provider errors across the existing Promise-based runner boundary. */
export async function runPiAgentPromise(ctx: RunCtx, config: PiAgentConfig): Promise<void> {
  const result = await Effect.runPromise(Effect.either(runPiAgent(ctx, config)));
  if (result._tag === 'Left') throw result.left.cause ?? result.left;
}
