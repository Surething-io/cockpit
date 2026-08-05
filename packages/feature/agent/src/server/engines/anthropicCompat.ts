/**
 * Engine shape for providers that expose BOTH protocols behind one API key:
 * an Anthropic-compatible endpoint (driven by the Claude Agent SDK) and an
 * OpenAI-compatible one (driven by our own Built-in Agent loop). DeepSeek and
 * Kimi are both exactly this, so the lifecycle — key preflight, model
 * resolution, spawn env, mode branch — lives here once and each provider
 * contributes only its endpoints and its model rules.
 *
 * What is deliberately NOT shared: the model *whitelist*. DeepSeek's
 * Anthropic-compatible endpoint has no listing API, so it hardcodes a pair;
 * Kimi lists live models for both protocols. That difference is the whole
 * reason `resolveSdkModel` is a provider hook rather than a config field.
 */
import { SETTINGS_FILE, getBuiltinSessionsRoot, readJsonFile, sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { getSessionTitle } from '../state/globalState';
import { runSdkLoop, type BuildSdkOptions } from './shared/sdkLoop';
import { runBuiltinAgent, requireTextPrompt, type BuiltinAgentConfig } from './builtinAgent';
import { createOpenAiCompatModel } from './builtinAgent/model';
import type { ApiKeyStore } from './credentials';
import type { DispatchParams, EngineSpec, RunCtx } from './types';

/** Per-engine slice of settings.json. The API key is NOT here — see credentials.ts. */
export interface EngineModelSettings {
  /** SDK mode. */
  model?: string;
  /** Built-in Agent mode. Separate key so a builtin-only model never becomes the SDK default. */
  builtinModel?: string;
  /**
   * SDK mode: context window + thinking effort of the selected model, copied from the
   * provider's live model metadata when the user picked it in the picker. Kept here
   * rather than re-fetched at run time so starting a chat costs no extra round trip;
   * the engine falls back to its own defaults when absent.
   */
  modelContextTokens?: number;
  modelEffort?: string;
}

interface CockpitSettings {
  engines?: Record<string, EngineModelSettings | undefined>;
  [key: string]: unknown;
}

export interface AnthropicCompatProvider {
  /** Engine id. Doubles as the settings key and the Built-in Agent store key. */
  name: string;
  /** Human-readable name, used in the "no API key" preflight error. */
  label: string;
  /** Anthropic-compatible endpoint (SDK mode). */
  anthropicBaseUrl: string;
  /** OpenAI-compatible endpoint (Built-in Agent mode). */
  openAiBaseUrl: string;
  /** CLAUDE_CONFIG_DIR for SDK mode — isolates sessions/credentials from the user's real ~/.claude. */
  configDir: string;
  /** Fallback when a request carries no model and settings hold none. */
  defaultModel: string;
  apiKey: ApiKeyStore;
  /** SDK mode: turn the requested/saved ids into the id to run. */
  resolveSdkModel(requested: string | undefined, saved: string | undefined): string;
  /**
   * SDK mode: id as it goes on the wire, when it differs from the id the picker shows.
   * Defaults to identity.
   */
  sdkWireModel?(model: string): string;
  /** Model the SDK uses for small/fast subtasks (title gen, compaction). Defaults to the main model. */
  smallFastModel?: string;
  /** Provider-specific spawn env, merged last so it can override the shared defaults. */
  sdkEnv?(model: string, settings: EngineModelSettings): Record<string, string | undefined>;
  /** Set DISABLE_PROMPT_CACHING — for providers that run their own server-side prefix cache. */
  disablePromptCaching?: boolean;
  /** Built-in Agent mode sampling temperature; `null` omits the field. See BuiltinAgentConfig. */
  builtinTemperature?: number | null;
}

async function readSettings(): Promise<CockpitSettings> {
  return readJsonFile<CockpitSettings>(SETTINGS_FILE, {});
}

/** Built-in mode: the live model list is the whitelist and the picker already filtered
 *  against it — take the first non-empty candidate and let the API reject an unknown id
 *  with its own message. */
function resolveBuiltinModel(
  requested: string | undefined,
  saved: string | undefined,
  fallback: string,
): string {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  if (saved && saved.trim()) return saved.trim();
  return fallback;
}

function buildBuiltinConfig(p: AnthropicCompatProvider, apiKey: string): BuiltinAgentConfig {
  return {
    sessionsRoot: getBuiltinSessionsRoot(p.name),
    defaultModel: p.defaultModel,
    createModel: async (modelName) =>
      createOpenAiCompatModel({ baseURL: p.openAiBaseUrl, apiKey, modelName }),
    ...(p.builtinTemperature !== undefined && { temperature: p.builtinTemperature }),
  };
}

/** We must REMOVE ANTHROPIC_AUTH_TOKEN (not blank it): some SDK paths check "is defined"
 *  and would emit an empty Bearer header → 401 — hence the `undefined` override, which
 *  sanitizedSpawnEnv deletes rather than blanks.
 *
 *  Exported for tests: every value here fails SILENTLY when wrong (a bad context limit just
 *  compacts early, a bad model alias only 404s mid-turn), so it is worth pinning down. */
export function buildEnv(
  p: AnthropicCompatProvider,
  apiKey: string,
  model: string,
  settings: EngineModelSettings,
): Record<string, string | undefined> {
  const wire = p.sdkWireModel ? p.sdkWireModel(model) : model;
  return sanitizedSpawnEnv({
    ANTHROPIC_AUTH_TOKEN: undefined,
    ANTHROPIC_BASE_URL: p.anthropicBaseUrl,
    ANTHROPIC_API_KEY: apiKey, // both providers accept this as x-api-key
    ANTHROPIC_MODEL: wire,
    ANTHROPIC_SMALL_FAST_MODEL: p.smallFastModel ?? wire,
    CLAUDE_CONFIG_DIR: p.configDir,
    ...(p.disablePromptCaching && { DISABLE_PROMPT_CACHING: '1' }),
    CLAUDE_CODE_USE_BEDROCK: '0',
    CLAUDE_CODE_USE_VERTEX: '0',
    CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1',
    ...p.sdkEnv?.(model, settings),
  });
}

function buildOptions(ctx: RunCtx, env: Record<string, string | undefined>): BuildSdkOptions {
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

export function makeAnthropicCompatSpec(p: AnthropicCompatProvider): EngineSpec {
  return {
    name: p.name,
    // Pre-check BEFORE startRun: API key must exist; resolve model into params (no registry pollution).
    async preflight(params: DispatchParams) {
      const settings = await readSettings();
      const saved = settings.engines?.[p.name] ?? {};
      const apiKey = await p.apiKey.read();
      if (!apiKey) {
        return {
          ok: false as const,
          status: 400,
          error: `${p.label} API key is not configured. Open the ${p.label} picker in the chat header to set one.`,
        };
      }
      const requested = typeof params.model === 'string' ? params.model : undefined;
      if (isBuiltinMode(params)) {
        // The built-in loop has no image support — reject images-only messages here rather
        // than letting the runner receive an undefined prompt.
        const textCheck = requireTextPrompt(params);
        if (!textCheck.ok) return textCheck;
        params.model = resolveBuiltinModel(requested, saved.builtinModel, p.defaultModel);
        return { ok: true as const };
      }
      params.model = p.resolveSdkModel(requested, saved.model);
      return { ok: true as const };
    },
    runner: {
      async run(ctx) {
        const apiKey = await p.apiKey.read(); // preflight guaranteed non-empty
        if (isBuiltinMode(ctx.params)) {
          await runBuiltinAgent(ctx, buildBuiltinConfig(p, apiKey));
          return;
        }
        const settings = await readSettings();
        const model = typeof ctx.params.model === 'string' ? ctx.params.model : p.defaultModel;
        const env = buildEnv(p, apiKey, model, settings.engines?.[p.name] ?? {});
        await runSdkLoop(ctx, buildOptions(ctx, env));
      },
      resolveTitle: (cwd, sessionId) => getSessionTitle(cwd, sessionId),
    },
  };
}
