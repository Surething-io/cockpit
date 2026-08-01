import { DEEPSEEK_DIR, SETTINGS_FILE, getBuiltinSessionsRoot, readJsonFile, sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { readDeepseekApiKey } from './deepseekCredentials';
import { getSessionTitle } from '../state/globalState';
import { runSdkLoop, type BuildSdkOptions } from './shared/sdkLoop';
import { runBuiltinAgent, requireTextPrompt, type BuiltinAgentConfig } from './builtinAgent';
import { createOpenAiCompatModel } from './builtinAgent/model';
import type { DispatchParams, EngineSpec, RunCtx } from './types';

// DeepSeek's Anthropic-compatible endpoint. https://api-docs.deepseek.com/zh-cn/guides/anthropic_api
const DEEPSEEK_BASE_URL = 'https://api.deepseek.com/anthropic';
const DEFAULT_MODEL = 'deepseek-v4-pro';
// Used by the SDK for fast/small subtasks (title gen, compaction).
const SMALL_FAST_MODEL = 'deepseek-v4-flash';
const ALLOWED_MODELS = new Set(['deepseek-v4-flash', 'deepseek-v4-pro']);

// Built-in Agent mode talks to the OpenAI-compatible endpoint instead. Its /v1/models
// currently reports the SAME ids as ALLOWED_MODELS above, but it is the authoritative,
// live list (the Anthropic-compatible endpoint has no listing API), so this mode takes
// whatever the picker read from GET /api/deepseek/models rather than re-checking a
// hardcoded set — a model DeepSeek ships tomorrow works without a cockpit release.
// This constant only covers a request that carries no model at all.
const DEEPSEEK_OPENAI_BASE_URL = 'https://api.deepseek.com/v1';
const BUILTIN_DEFAULT_MODEL = DEFAULT_MODEL;

// Only `model` lives in settings.json now; the API key is stored separately
// in the DeepSeek credential file (see deepseekCredentials.ts).
interface CockpitSettings {
  engines?: { deepseek?: { model?: string; builtinModel?: string } };
  [key: string]: unknown;
}

async function readSettings(): Promise<CockpitSettings> {
  return readJsonFile<CockpitSettings>(SETTINGS_FILE, {});
}

function resolveModel(requested: string | undefined, saved: string | undefined): string {
  if (typeof requested === 'string' && ALLOWED_MODELS.has(requested)) return requested;
  if (saved && ALLOWED_MODELS.has(saved)) return saved;
  return DEFAULT_MODEL;
}

/** Built-in mode: the live /v1/models list is the whitelist, and the picker already
 *  filtered against it — take the first non-empty candidate and let the API reject an
 *  unknown id with its own message. */
function resolveBuiltinModel(requested: string | undefined, saved: string | undefined): string {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  if (saved && saved.trim()) return saved.trim();
  return BUILTIN_DEFAULT_MODEL;
}

function buildBuiltinConfig(apiKey: string): BuiltinAgentConfig {
  return {
    sessionsRoot: getBuiltinSessionsRoot('deepseek'),
    defaultModel: BUILTIN_DEFAULT_MODEL,
    createModel: async (modelName) =>
      createOpenAiCompatModel({ baseURL: DEEPSEEK_OPENAI_BASE_URL, apiKey, modelName }),
  };
}

/** Inject DeepSeek's Anthropic-compatible env. We must REMOVE ANTHROPIC_AUTH_TOKEN (not blank it):
 *  some SDK paths check "is defined" and would emit an empty Bearer header → 401 — hence the
 *  `undefined` override, which sanitizedSpawnEnv deletes rather than blanks. */
function buildDeepseekEnv(apiKey: string, model: string): Record<string, string | undefined> {
  return sanitizedSpawnEnv({
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: DEEPSEEK_BASE_URL,
    ANTHROPIC_API_KEY: apiKey, // DeepSeek sends this as x-api-key (fully supported)
    ANTHROPIC_MODEL: model,
    ANTHROPIC_SMALL_FAST_MODEL: SMALL_FAST_MODEL,
    CLAUDE_CONFIG_DIR: DEEPSEEK_DIR,
    DISABLE_PROMPT_CACHING: '1', // DeepSeek runs its own server-side prefix KV cache
    CLAUDE_CODE_USE_BEDROCK: '0',
    CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
  });
}

function buildDeepseekOptions(ctx: RunCtx, env: Record<string, string | undefined>): BuildSdkOptions {
  return (abort, resume) => ({
    ...(resume && { resume }),
    ...(ctx.cwd && { cwd: ctx.cwd }),
    settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>,
    permissionMode: 'bypassPermissions' as const,
    allowDangerouslySkipPermissions: true,
    includePartialMessages: true,
    abortController: abort,
    env,
  });
}

/** Execution mode for this run. 'builtin' = Cockpit's own agent loop (engines/builtinAgent),
 *  anything else = Claude Agent SDK, which stays the default for existing sessions. */
const isBuiltinMode = (params: DispatchParams): boolean => params.mode === 'builtin';

export const deepseekSpec: EngineSpec = {
  name: 'deepseek',
  // Pre-check BEFORE startRun: API key must exist; resolve model into params (no registry pollution).
  async preflight(params: DispatchParams) {
    const settings = await readSettings();
    const apiKey = await readDeepseekApiKey();
    if (!apiKey) {
      return {
        ok: false as const,
        status: 400,
        error: 'DeepSeek API key is not configured. Open the DeepSeek picker in the chat header to set one.',
      };
    }
    const requested = typeof params.model === 'string' ? params.model : undefined;
    if (isBuiltinMode(params)) {
      // The built-in loop has no image support — reject images-only messages here rather
      // than letting the runner receive an undefined prompt.
      const textCheck = requireTextPrompt(params);
      if (!textCheck.ok) return textCheck;
      params.model = resolveBuiltinModel(requested, settings.engines?.deepseek?.builtinModel);
      return { ok: true as const };
    }
    params.model = resolveModel(requested, settings.engines?.deepseek?.model);
    return { ok: true as const };
  },
  runner: {
    async run(ctx) {
      const apiKey = await readDeepseekApiKey(); // preflight guaranteed non-empty
      if (isBuiltinMode(ctx.params)) {
        await runBuiltinAgent(ctx, buildBuiltinConfig(apiKey));
        return;
      }
      const model = typeof ctx.params.model === 'string' ? ctx.params.model : DEFAULT_MODEL;
      const env = buildDeepseekEnv(apiKey, model);
      await runSdkLoop(ctx, buildDeepseekOptions(ctx, env));
    },
    resolveTitle: (cwd, sessionId) => getSessionTitle(cwd, sessionId),
  },
};
