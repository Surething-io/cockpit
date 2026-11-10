// Dynamic Pi-internal subagents; no predefined roles and no Cockpit /dl dependency.
// Single/parallel/chain semantics follow Pi's official examples/extensions/subagent.
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { Effect } from 'effect';
import type { ExtensionFactory, ModelRuntime, ToolDefinition } from '@earendil-works/pi-coding-agent';
import { AgentError } from '@cockpit/effect-core';
import { BUILTIN_SKILLS_SRC_DIR, PI_AGENT_DIR, sanitizedSpawnEnv } from '@cockpit/shared-utils';
import type { PiAgentConfig } from './piAgentLive';
import { piChildSelection, resolvePiModel, type PiResolvedModel } from './piModelLive';
import { createPiChildSession, finishPiChildSession, retainPiChildPartial, retainPiChildStop } from './piSubagentSessionLive';
import { runPiChildProcess } from './piSubagentProcessLive';
import { startPiChild, type PiChildResult } from '../server/engines/shared/piSubagentProcess';

const TOOLS = ['read', 'write', 'edit', 'bash', 'grep', 'find', 'ls'];
interface Task { task: string; instructions?: string; model?: string; tools?: string[]; cwd?: string; name?: string }
interface Params extends Partial<Task> { tasks?: Task[]; chain?: Task[] }
interface Result extends PiChildResult { id: string; name: string; task: string; model: string; status: 'running' | 'done' | 'failed' | 'truncated'; sessionPath?: string }

/** Build one explicitly loaded extension using the parent's effective runtime configuration. */
export const makePiSubagentExtension = (
  config: PiAgentConfig, runtime: ModelRuntime, parentModel: string, parentSignal: AbortSignal, parentRunId: string, parentSessionPath: string, parentResolved?: PiResolvedModel,
): Effect.Effect<ExtensionFactory, AgentError> => Effect.tryPromise({
  try: async () => {
    const { Type } = await import('typebox');
    const taskFields = {
      task: Type.String({ minLength: 1, description: 'Self-contained task for a fresh, independent context' }),
      instructions: Type.Optional(Type.String({ description: 'Instructions for this dynamically created agent' })),
      model: Type.Optional(Type.String({ description: 'Optional provider/model; defaults to the parent model' })),
      tools: Type.Optional(Type.Array(Type.String({ enum: TOOLS }), { maxItems: TOOLS.length })),
      cwd: Type.Optional(Type.String()), name: Type.Optional(Type.String({ description: 'Display label only, not a predefined agent' })),
    };
    const item = Type.Object(taskFields);
    const parameters = Type.Object({ ...taskFields, task: Type.Optional(taskFields.task),
      tasks: Type.Optional(Type.Array(item, { minItems: 1, maxItems: 8 })),
      chain: Type.Optional(Type.Array(item, { minItems: 1, maxItems: 8 })),
    });
    return (pi) => {
      pi.registerTool({
        name: 'subagent', label: 'Subagent',
        description: 'Create independent Pi agents dynamically. Supply task (+ optional instructions/model/tools), tasks for parallel execution (up to 8; 4 concurrent), or chain with {previous} placeholders. No predefined agent names. Children have no subagent tool. Use self-contained instructions; only results return to this context. Repeated tool cycles receive a warning, then stop only that child. Use its retained results or change the approach after a no_progress failure.',
        parameters,
        async execute(callId, input, toolSignal, onUpdate, ctx) {
          const params = input as Params;
          const signal = toolSignal ? AbortSignal.any([parentSignal, toolSignal]) : parentSignal;
          const problem = (cause: unknown) => new AgentError({ provider: config.engine, kind: 'protocol', cause });
          const io = <A>(fn: () => Promise<A>): Effect.Effect<A, AgentError> => Effect.tryPromise({ try: fn, catch: problem });
          const results: Result[] = [];
          const progress = () => onUpdate?.({ content: [{ type: 'text', text: results.filter(Boolean).map((r) => `[${r.status}] ${r.name} (${r.model})\n${r.output}`).join('\n\n') }], details: { subagents: results.filter(Boolean).map((r) => ({ ...r })) } });
          const run = (task: Task, index: number): Effect.Effect<Result, AgentError> => Effect.scoped(Effect.gen(function* () {
            if (signal.aborted) return yield* Effect.fail(problem(new Error('Subagent cancelled')));
            if (!task.task?.trim() || task.task.length > 200000 || (task.instructions?.length ?? 0) > 200000) return yield* Effect.fail(problem(new Error('A nonempty task and bounded instructions are required')));
            if (task.tools?.some((tool) => !TOOLS.includes(tool))) return yield* Effect.fail(problem(new Error('Unsupported subagent tool')));
            const parentProvider = ctx.model?.provider ?? config.engine;
            const parentModelId = ctx.model?.id ?? parentModel;
            const selection = yield* piChildSelection(config, parentModel, task.model ?? `${parentProvider}/${parentModelId}`);
            const model = selection.model;
            const resolved = parentResolved && selection.config.engine === config.engine && model === parentModel
              ? parentResolved : yield* resolvePiModel(runtime, selection.config, model);
            const definition = resolved.definition;
            const result: Result = { id: randomUUID(), name: task.name || 'Subagent', task: task.task, model: `${selection.config.engine}/${model}`,
              status: 'running', output: '', usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
            results[index] = result; progress();
            const root = dirname(BUILTIN_SKILLS_SRC_DIR);
            const cwd = resolve(ctx.cwd, task.cwd || '.');
            const temp = yield* Effect.acquireRelease(io(async () => {
              const dir = join(PI_AGENT_DIR, 'tmp'); await mkdir(dir, { recursive: true, mode: 0o700 });
              return mkdtemp(join(dir, 'subagent-'));
            }), (dir) => io(() => rm(dir, { recursive: true, force: true })).pipe(Effect.catchAll((error) => Effect.logWarning('Cannot remove Pi subagent temporary files', error))));
            const prompt = join(temp, 'instructions.md');
            yield* io(() => writeFile(prompt, task.instructions || 'Complete the delegated task and return a concise result. Do not spawn further agents.', { mode: 0o600 }));
            const history = yield* createPiChildSession(parentSessionPath, parentRunId, cwd, {
              id: result.id, index, toolUseId: callId, name: result.name, task: result.task, model: result.model,
            }, task.instructions || 'Complete the delegated task and return a concise result. Do not spawn further agents.').pipe(Effect.mapError(problem));
            result.sessionPath = history.sessionPath;
            const childPath = resolve(dirname(parentSessionPath), parentRunId, history.sessionPath);
            yield* Effect.addFinalizer(() => finishPiChildSession(parentSessionPath, parentRunId, history,
              signal.aborted ? 'cancelled' : result.status === 'running' ? 'failed' : result.status).pipe(
                Effect.catchAll((error) => Effect.logWarning('Cannot finalize Pi child history', error))));
            const args = ['--mode', 'rpc', '--session-dir', dirname(childPath), '--session', childPath, '--no-extensions', '--no-mcp', '--no-prompt-templates', '--no-themes',
              '--extension', join(root, 'bin', 'pi-subagent-provider.mjs'),
              '--extension', join(root, 'bin', 'pi-subagent-progress.mjs'), '--model', result.model,
              '--append-system-prompt', prompt, ...(task.tools?.length === 0 ? ['--no-tools'] : ['--tools', (task.tools ?? TOOLS).join(',')])];
            const inheritedThinking = selection.config.engine === parentProvider && model === parentModelId ? ctx.thinkingLevel : undefined;
            args.push('--thinking', inheritedThinking && (inheritedThinking !== 'off' || resolved.capabilities.thinking !== 'required')
              ? inheritedThinking : resolved.capabilities.defaultThinking);
            const finished = yield* runPiChildProcess(Effect.try({
              try: () => startPiChild(join(root, 'bin', 'pi-subagent-entry.mjs'), args, cwd, sanitizedSpawnEnv({
                PI_CODING_AGENT_DIR: PI_AGENT_DIR, PI_OFFLINE: '1', COCKPIT_RUN_ID: parentRunId, COCKPIT_CWD: cwd,
                COCKPIT_PI_SUBAGENT_API_KEY: selection.config.apiKey,
                COCKPIT_PI_SUBAGENT_MODEL: JSON.stringify({ provider: selection.config.engine, config: { baseUrl: selection.config.baseUrl, api: 'openai-completions', models: [definition], headers: resolved.providerHeaders } }),
              }), (text) => { result.output = text; progress(); }, `Task: ${task.task}`), catch: problem,
            }), (finished) => Effect.gen(function* () {
              if (finished.needsHistoryFallback) yield* retainPiChildPartial(childPath, finished.output).pipe(
                Effect.catchAll((error) => Effect.logWarning('Cannot retain interrupted Pi child output', error)));
              if (finished.executionStop) yield* retainPiChildStop(childPath, finished.executionStop).pipe(
                Effect.catchAll((error) => Effect.logWarning('Cannot retain Pi child stop', error)));
            }));
            Object.assign(result, finished, { status: finished.truncated ? 'truncated' : finished.error ? 'failed' : 'done' });
            progress(); return result;
          })).pipe(Effect.catchAll((error) => Effect.sync(() => {
            const result: Result = results[index] ?? { id: randomUUID(), name: task.name || 'Subagent', task: task.task,
              model: task.model || `${config.engine}/${parentModel}`, status: 'failed', output: '',
              usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 } };
            result.status = 'failed'; result.error = String(error.cause);
            results[index] = result; progress(); return result;
          })));
          const program = Effect.gen(function* () {
            if (Number(!!params.task) + Number(!!params.tasks?.length) + Number(!!params.chain?.length) !== 1) return yield* Effect.fail(problem(new Error('Provide exactly one of task, tasks, or chain')));
            const tasks = params.tasks ?? params.chain ?? [params as Task];
            if (tasks.length > 8) return yield* Effect.fail(problem(new Error('At most 8 subagent tasks are allowed')));
            if (params.chain) {
              let previous = '';
              for (const [index, task] of tasks.entries()) {
                const result = yield* run({ ...task, task: task.task.replaceAll('{previous}', previous) }, index);
                if (result.error) break;
                previous = result.output;
              }
            } else yield* Effect.forEach(tasks, (task, index) => run(task, index), { concurrency: 4 });
            return results;
          });
          const exit = await Effect.runPromise(Effect.either(program), { signal });
          const error = exit._tag === 'Left' ? String(exit.left.cause) : undefined;
          return { content: [{ type: 'text', text: error || results.filter(Boolean).map((r) => `[${r.status}] ${r.name} (${r.model})\n${[r.error, r.output].filter(Boolean).join('\n\n') || '(no output)'}\nUsage: ${JSON.stringify(r.usage)}`).join('\n\n') }],
            details: { subagents: results }, isError: !!error || results.some((r) => !!r.error) };
        },
      } as ToolDefinition<typeof parameters>);
    };
  }, catch: (cause) => new AgentError({ provider: config.engine, kind: 'protocol', cause }),
});
