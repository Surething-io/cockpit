import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { Cause, Effect, Exit, Option, Queue } from 'effect';
import { AgentError, CockpitConfig, FSError } from '@cockpit/effect-core';
import { sanitizedSpawnEnv, getSessionFilePath, readJsonFile, mutateJsonFile } from '@cockpit/shared-utils';
import { grokModelCatalog } from '../server/engines/grokAcp/models';
import { GrokAcpClient, GrokRpcError, object, type AcpObject, type AcpNotification } from '../server/engines/grokAcp/client';
import { GrokEventAdapter, grokCompletion, grokTranscriptEvent } from '../server/engines/grokAcp/events';
import type { RunCtx, RunEvent } from '../server/engines/types';
import { appendGrokTranscript } from './grokSessionLive';
import { prepareGrokContext, finishGrokContext } from './grokNativeSessionLive';

const agentError = (cause: unknown): AgentError => new AgentError({ provider: 'grok', kind: 'protocol', cause });

export interface GrokRunOptions { binary?: string; args?: string[] }

/** Promise boundary for EngineRunner; preserve the CLI's actionable error message. */
export async function runGrokTurn(ctx: RunCtx, options?: GrokRunOptions): Promise<void> {
  const exit = await Effect.runPromiseExit(runGrok(ctx, options), { signal: ctx.signal });
  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);
    if (error instanceof AgentError && error.cause instanceof Error) throw error.cause;
    throw error;
  }
}

/** One cold ACP connection per turn, with native Grok session context on resume. */
export function runGrok(ctx: RunCtx, options: GrokRunOptions = {}): Effect.Effect<void, AgentError | FSError> {
  return Effect.scoped(Effect.gen(function* () {
    const nativeResumeId = ctx.sessionId ? yield* prepareGrokContext(ctx.cwd, ctx.sessionId, ctx.params.noHistory === true) : undefined;
    if (ctx.sessionId && ctx.params.noHistory) {
      yield* Effect.addFinalizer(() => finishGrokContext(ctx.cwd, ctx.sessionId!).pipe(
        Effect.catchAll((error) => Effect.logError('Cannot merge independent Grok context; recovery will retry before the next resume', error)),
      ));
    }
    const cfg = yield* CockpitConfig;
    const settingsPath = join(cfg.cockpitDir, 'settings.json');
    const settings = yield* Effect.tryPromise({
      try: async () => {
        const text = await readFile(settingsPath, 'utf8').catch((cause: NodeJS.ErrnoException) => {
          if (cause.code === 'ENOENT') return '{}';
          throw cause;
        });
        return object(object(JSON.parse(text)).grok);
      },
      catch: (cause) => new FSError({ path: settingsPath, op: 'read', cause }),
    });
    const queue = yield* Queue.unbounded<AcpNotification>();
    yield* Effect.addFinalizer(() => Queue.shutdown(queue));
    const offer = (method: string, params: AcpObject): void => { queue.unsafeOffer({ method, params }); };
    const env = sanitizedSpawnEnv({ COCKPIT_RUN_ID: ctx.currentKey(), COCKPIT_CWD: ctx.cwd || undefined });
    // This provider uses the CLI subscription even if the host also has an API key.
    delete env.XAI_API_KEY;
    const session = { id: nativeResumeId };
    const client = yield* Effect.acquireRelease(
      Effect.try({
        try: () => new GrokAcpClient({
          binary: options.binary ?? (typeof settings.binaryPath === 'string' && settings.binaryPath.trim() ? settings.binaryPath.trim() : undefined),
          args: options.args, cwd: ctx.cwd || process.cwd(), env,
          onNotification: ({ method, params }) => offer(method, params),
          onClosed: (error) => offer('$closed', { error }),
          onRequest: (method, params) => {
            if (method === 'session/request_permission') {
              offer('$notice', { text: 'Grok requested additional permission. The operation was cancelled; review the request before trying again.' });
              return { outcome: { outcome: 'cancelled' } };
            }
            if (/^_?x\.ai\/ask_user_question$/.test(method)) {
              const questions = Array.isArray(params.questions) ? params.questions.map((q) => String(object(q).question ?? '')).join('\n\n') : '';
              offer('$notice', { text: `${questions}\n\nReply in the next message to continue.` });
              return { outcome: 'cancelled' };
            }
            if (/^_?x\.ai\/exit_plan_mode$/.test(method)) {
              offer('$notice', { text: String(params.plan ?? params.planMarkdown ?? params.plan_markdown ?? 'Grok proposed a plan. Reply to continue.') });
              return { outcome: 'abandoned', feedback: 'The client captured the plan. Stop and wait for the user to respond in a later turn.' };
            }
            throw new Error(`Unsupported Grok ACP client request: ${method}`);
          },
        }),
        catch: agentError,
      }),
      (connection) => Effect.gen(function* () {
        if (ctx.signal.aborted && session.id) {
          yield* Effect.try({ try: () => connection.notify('session/cancel', { sessionId: session.id, _meta: { cancelTrigger: 'ctrl_c' } }), catch: agentError }).pipe(Effect.ignore);
          yield* Effect.sleep('100 millis');
        }
        yield* Effect.sync(() => connection.dispose());
        const exited = yield* Effect.promise(() => connection.exited).pipe(Effect.timeoutOption('3 seconds'));
        if (Option.isNone(exited)) {
          yield* Effect.sync(() => connection.dispose(true));
          yield* Effect.promise(() => connection.exited).pipe(Effect.timeout('1 second'), Effect.ignore);
        }
      }),
    );
    const request = (method: string, params: AcpObject): Effect.Effect<AcpObject, AgentError> =>
      Effect.tryPromise({ try: () => client.request(method, params), catch: agentError }).pipe(
        Effect.timeoutFail({ duration: '30 seconds', onTimeout: () => agentError(new Error(`Grok ACP ${method} timed out`)) }),
      );
    const info = { name: 'cockpit', version: '1' };
    const initialized = yield* request('initialize', {
      protocolVersion: 2, info, capabilities: {}, clientInfo: info,
      clientCapabilities: { fs: { readTextFile: false, writeTextFile: false }, terminal: false },
      _meta: { clientType: 'extension' },
    });
    if (initialized.protocolVersion !== 1 && initialized.protocolVersion !== 2) {
      return yield* Effect.fail(agentError(new Error('Unsupported Grok ACP protocol version')));
    }
    const v2 = 'info' in initialized;
    const capabilities = object(v2 ? initialized.capabilities : initialized.agentCapabilities);
    const setup = (): Effect.Effect<AcpObject, AgentError> => {
      const params = { cwd: ctx.cwd || process.cwd(), mcpServers: [] };
      if (!nativeResumeId) return request('session/new', params);
      const canLoad = !v2 && capabilities.loadSession === true;
      const resumeCapabilities = object(v2 ? capabilities.session : capabilities.sessionCapabilities);
      if (!canLoad && resumeCapabilities.resume == null) return Effect.fail(agentError(new Error('Grok CLI does not support restoring this session. Update Grok Build.')));
      return request(canLoad ? 'session/load' : 'session/resume', { ...params, sessionId: nativeResumeId });
    };
    const opened = yield* setup().pipe(Effect.catchAll((error) => {
      if (!(error.cause instanceof GrokRpcError) || error.cause.code !== -32000) return Effect.fail(error);
      return request(v2 ? 'auth/login' : 'authenticate', { methodId: 'cached_token' }).pipe(
        Effect.mapError((cause) => agentError(new Error(`Grok subscription authentication failed. Run grok login in a terminal. ${String(cause.cause)}`))),
        Effect.flatMap(setup),
      );
    }));
    const nativeSessionId = typeof opened.sessionId === 'string' ? opened.sessionId : nativeResumeId;
    const sessionId = ctx.sessionId ?? nativeSessionId;
    if (!sessionId || !nativeSessionId) return yield* Effect.fail(agentError(new Error('Grok ACP returned no session id')));
    session.id = nativeSessionId;
    ctx.rekey(sessionId);
    ctx.emit({ type: 'system', subtype: 'init', session_id: sessionId });
    // Discard load-time replay: the display transcript already contains those turns.
    yield* Queue.takeAll(queue);
    const preferencesPath = getSessionFilePath(ctx.cwd || process.cwd());
    type Preferences = { sessions?: string[]; grokModels?: Record<string, string>; grokReasoningEfforts?: Record<string, string> };
    const preferences = yield* Effect.tryPromise({
      try: () => readJsonFile<Preferences>(preferencesPath, {}),
      catch: (cause) => new FSError({ path: preferencesPath, op: 'read', cause }),
    });
    const model = typeof ctx.params.model === 'string' ? ctx.params.model.trim() : preferences.grokModels?.[sessionId] ?? '';
    const reasoning = ctx.params.grokReasoningEffort ?? preferences.grokReasoningEfforts?.[sessionId];
    if (reasoning && !/^[a-z0-9][a-z0-9._-]{0,31}$/i.test(reasoning)) {
      return yield* Effect.fail(agentError(new Error('Invalid Grok reasoning effort')));
    }
    const catalog = grokModelCatalog(initialized);
    const targetModel = model && model !== 'grok-build' ? model : String(object(opened.models).currentModelId ?? catalog.defaultModel);
    if ((model && model !== 'grok-build') || reasoning) {
      yield* request(v2 ? 'session/set_config_option' : 'session/set_model', v2
        ? { sessionId: nativeSessionId, configId: 'model', value: targetModel }
        : { sessionId: nativeSessionId, modelId: targetModel, ...(reasoning ? { _meta: { reasoningEffort: reasoning } } : {}) });
      if (v2 && reasoning) {
        const config = (Array.isArray(opened.configOptions) ? opened.configOptions : []).map(object).find((option) => option.category === 'thought_level');
        if (!config || typeof config.id !== 'string') return yield* Effect.fail(agentError(new Error('Grok CLI did not advertise a reasoning selector for this model')));
        yield* request('session/set_config_option', { sessionId: nativeSessionId, configId: config.id, value: reasoning });
      }
    }
    yield* Effect.tryPromise({
      try: () => mutateJsonFile<Preferences>(preferencesPath, {}, (current) => ({
        ...current, grokModels: { ...current.grokModels, [sessionId]: targetModel },
        grokReasoningEfforts: { ...current.grokReasoningEfforts, [sessionId]: reasoning ?? '' },
      })), catch: (cause) => new FSError({ path: preferencesPath, op: 'write', cause }),
    });
    if (ctx.images?.length && object(capabilities.promptCapabilities).image !== true && !v2) {
      return yield* Effect.fail(agentError(new Error('This Grok CLI does not support image prompts. Send text or update Grok Build.')));
    }
    yield* appendGrokTranscript(ctx.cwd, sessionId, { type: 'system', subtype: 'init', engine: 'grok', model: targetModel });
    const inputSourceId = yield* appendGrokTranscript(ctx.cwd, sessionId, { type: 'user', message: { role: 'user', content: [
      ...(ctx.prompt ? [{ type: 'text', text: ctx.prompt }] : []),
      ...(ctx.images ?? []).map((image) => ({ type: 'image', source: image })),
    ] } });
    if (typeof ctx.params.runId === 'string') ctx.emit({ type: 'system', subtype: 'input_binding', inputId: ctx.params.runId, sourceId: inputSourceId });
    const promptId = randomUUID();
    const prompt = [
      ...(ctx.prompt || ctx.outputStyle ? [{ type: 'text', text: [ctx.prompt, ctx.outputStyle].filter(Boolean).join('\n\n') }] : []),
      ...(ctx.images ?? []).map((image) => ({ type: 'image', mimeType: image.media_type, data: image.data })),
    ];
    yield* Effect.forkScoped(Effect.tryPromise({
      try: () => client.request('session/prompt', { sessionId: nativeSessionId, prompt, _meta: { promptId, requestId: promptId } }),
      catch: agentError,
    }).pipe(Effect.match({
      onFailure: (error) => offer('$closed', { error: error.cause }),
      onSuccess: (response) => { if (!v2 && typeof response.stopReason === 'string') offer('$complete', response); },
    })));
    const adapter = new GrokEventAdapter();
    let foregroundComplete = false;
    let pendingBlocks: AcpObject[] = [];
    const flush = (usage?: AcpObject): Effect.Effect<void, FSError> => Effect.suspend(() => {
      if (!pendingBlocks.length && !usage) return Effect.void;
      const content = pendingBlocks;
      pendingBlocks = [];
      return appendGrokTranscript(ctx.cwd, sessionId, { type: 'assistant', message: {
        role: 'assistant', content, model: targetModel, ...(usage ? { usage } : {}),
      } }).pipe(Effect.asVoid);
    });
    yield* Effect.addFinalizer(() => flush().pipe(Effect.catchAll((error) => Effect.logWarning('Cannot save partial Grok output', error))));
    const finish = (): void => { ctx.emit({ type: 'result', subtype: 'success', session_id: sessionId }); };
    const fail = (cause: unknown): Effect.Effect<never, AgentError | FSError> => flush().pipe(Effect.andThen(appendGrokTranscript(ctx.cwd, sessionId, {
      type: 'user', isMeta: true, message: { role: 'user', content: `Grok error: ${cause instanceof Error ? cause.message : String(cause)}` },
    })), Effect.flatMap(() => Effect.fail(agentError(cause))));
    const emit = (event: RunEvent): Effect.Effect<void, FSError> => Effect.gen(function* () {
      ctx.emit(event);
      const record = grokTranscriptEvent(event);
      if (!record) return;
      if (event.type === 'stream_event') {
        const blocks = object(record.message).content as AcpObject[];
        for (const block of blocks) {
          const previous = pendingBlocks.at(-1);
          const key = block.type === 'thinking' ? 'thinking' : 'text';
          if (previous && previous.type === block.type) previous[key] = String(previous[key] ?? '') + String(block[key] ?? '');
          else pendingBlocks.push(block);
        }
      } else {
        yield* flush();
        yield* appendGrokTranscript(ctx.cwd, sessionId, record);
      }
    });
    while (true) {
      const { method, params } = yield* Queue.take(queue);
      if (typeof params.sessionId === 'string' && params.sessionId !== nativeSessionId) continue;
      if (method === '$closed') return yield* fail(params.error);
      if (method === '$notice') {
        yield* emit({ type: 'assistant', message: { content: [{ type: 'text', text: String(params.text) }] } });
        continue;
      }
      const update = object(params.update);
      const completionId = update.prompt_id ?? update.promptId ?? params.promptId;
      const isWake = typeof completionId === 'string' && completionId.startsWith('task-completed-');
      const completion = method === '$complete' ? params
        : (method === 'session/update' || /^_?x\.ai\/(session_notification|session\/update|session\/prompt_complete)$/.test(method))
          ? grokCompletion(params, isWake && foregroundComplete && adapter.waitingForBackground ? completionId : promptId, v2) : null;
      if (completion) {
        const reason = completion.stop_reason ?? completion.stopReason;
        if (reason === 'error' || completion.error) return yield* fail(new Error(String(completion.agent_result ?? completion.agentResult ?? completion.error ?? 'Grok prompt failed')));
        foregroundComplete = true;
        if (isWake || v2) adapter.finishWake();
        if (!adapter.waitingForBackground) { finish(); return; }
        continue;
      }
      if (method === 'session/update' || /^_?x\.ai\/(session_notification|session\/update)$/.test(method)) {
        for (const event of adapter.update(update)) yield* emit(event);
        if (update.sessionUpdate === 'response_completed') {
          const usage = object(update.usage);
          ctx.emit({ type: 'usage_update', output_tokens: usage.output_tokens });
          yield* flush(usage);
        }
        if (foregroundComplete && !adapter.waitingForBackground) { finish(); return; }
      }
    }
  })).pipe(
    // Retry a failed finalizer merge on success so a durable-write failure reaches the caller.
    Effect.tap(() => ctx.sessionId && ctx.params.noHistory ? finishGrokContext(ctx.cwd, ctx.sessionId) : Effect.void),
    Effect.withSpan('agent.grok.run'),
  );
}
