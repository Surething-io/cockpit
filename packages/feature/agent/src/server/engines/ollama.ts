// Ollama model selection and provider binding for the Pi runtime.
import { resolveOllamaConnection, readOllamaLastModel, rememberOllamaLastModel } from '@cockpit/shared-utils';
import { runPiAgentPromise } from '../../effect/piAgentLive';
import { readPiModel } from '../../effect/piSessionLive';
import { listOllamaModels, type OllamaCatalogEntry } from './ollamaCatalog';
import type { DispatchParams, EngineSpec } from './types';

type Preflight = { ok: true } | { ok: false; status: number; error: string };

const fail = (error: string): Preflight => ({ ok: false, status: 400, error });

/** `gpt-oss` when the machine only has `gpt-oss:20b` — the exact 404 this engine kept hitting. */
function matchInstalled(requested: string, models: ReadonlyArray<OllamaCatalogEntry>): string | undefined {
  const exact = models.find((m) => m.name === requested);
  if (exact) return exact.name;
  const byTag = models.filter((m) => m.name.startsWith(`${requested}:`));
  return byTag.length === 1 ? byTag[0].name : undefined;
}

const nameList = (models: ReadonlyArray<OllamaCatalogEntry>) => models.map((m) => m.name).join(', ');

export type OllamaModelChoice = { ok: true; model: string } | { ok: false; reason: string };

/**
 * What a session with no history of its own should run on: the model last used anywhere,
 * else the first the machine reports.
 *
 * A pure query — it does NOT record anything. Asking "what would the default be" is not
 * using a model; only an actual dispatch is, and that goes through `resolveOllamaModel`
 * below. That is what lets GET /api/ollama/default-model share this function, so a new tab
 * in the UI is seeded with the exact value the engine would have picked for it. Before it
 * did, the picker opened blank on a new ollama chat and the two only met at send time.
 */
export async function resolveDefaultOllamaModel(): Promise<OllamaModelChoice> {
  const catalog = await listOllamaModels();
  if (!catalog.ok) {
    return { ok: false, reason: `${catalog.reason} Cockpit picks the model from that list.` };
  }
  if (catalog.models.length === 0) {
    return {
      ok: false,
      reason: `The Ollama server at ${catalog.baseUrl} has no models installed. Pull one with \`ollama pull <model>\` (e.g. \`ollama pull qwen3\`), then try again.`,
    };
  }
  const last = await readOllamaLastModel();
  // A remembered model the machine no longer has is no better than a hardcoded one.
  return { ok: true, model: (last && matchInstalled(last, catalog.models)) || catalog.models[0].name };
}

/**
 * Settle on a model BEFORE the run starts, so a bad one is a 400 on the dispatch — which the
 * caller reads — rather than a `⚠️ [HTTP 404] model … not found` written into a session that
 * then has to be thrown away. Order:
 *
 *   1. the request's own `model`, verified against the catalog (a bare name is completed to
 *      its installed tag when exactly one matches, so `gpt-oss` finds `gpt-oss:20b`);
 *   2. the model this session already ran on — a follow-up turn must not silently switch
 *      engines under a session just because the caller omitted the field;
 *   3. resolveDefaultOllamaModel above.
 *
 * An unreachable catalog only blocks (1) when it would have been the thing doing the
 * blocking: an explicitly requested model is passed through so a server whose list endpoints
 * we can't read (a proxy, llama.cpp) still works, and the provider gets to reject it itself.
 *
 * Whatever it lands on becomes the remembered one. Resuming an old session counts: "last
 * used" is meant literally, so the next new chat opens on what you were last working in.
 */
async function resolveOllamaModel(params: DispatchParams): Promise<Preflight> {
  const requested = typeof params.model === 'string' ? params.model.trim() : '';

  if (!requested) {
    const recorded = await readPiModel(params.cwd, params.sessionId, 'ollama');
    const choice = recorded ? { ok: true as const, model: recorded } : await resolveDefaultOllamaModel();
    if (!choice.ok) return fail(choice.reason);
    params.model = choice.model;
    await rememberOllamaLastModel(choice.model);
    return { ok: true };
  }

  const catalog = await listOllamaModels();
  if (!catalog.ok) {
    // Trust the caller when we cannot check: the run fails with the provider's own words.
    params.model = requested;
    return { ok: true };
  }

  const installed = matchInstalled(requested, catalog.models);
  if (!installed) {
    return fail(
      catalog.models.length === 0
        ? `The Ollama server at ${catalog.baseUrl} has no models installed, so '${requested}' cannot run. Pull it with \`ollama pull ${requested}\`.`
        : `Model '${requested}' is not installed on the Ollama server at ${catalog.baseUrl}. Available: ${nameList(catalog.models)}.`,
    );
  }
  params.model = installed;
  await rememberOllamaLastModel(installed);
  return { ok: true };
}

export const ollamaSpec: EngineSpec = {
  name: 'ollama',
  async preflight(params) {
    return resolveOllamaModel(params);
  },
  runner: {
    async run(ctx) {
      const connection = await resolveOllamaConnection();
      await runPiAgentPromise(ctx, { engine: 'ollama', baseUrl: `${connection.baseUrl}/v1`, apiKey: connection.apiKey || 'ollama' });
    },
    // No resolveTitle → teardown uses 'unread' with undefined title.
  },
};
