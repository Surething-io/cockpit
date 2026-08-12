/**
 * Engine shape for providers reached by one API key over an OpenAI-compatible endpoint
 * and driven by our own Built-in Agent loop (engines/builtinAgent). DeepSeek, Kimi and
 * GLM are all exactly this, so the lifecycle — key preflight, model resolution, run —
 * lives here once and each provider contributes only its endpoint and its defaults.
 *
 * These three used to ALSO offer a Claude Agent SDK mode against an Anthropic-compatible
 * endpoint. That mode is gone. It cost every session a second dimension: two transcript
 * stores that could not be switched between mid-session, a per-tab toggle, a second model
 * key in settings, and a `mode` field threaded from the tab through dispatch down to the
 * session store. Ollama's single-loop shape is the model now — one endpoint, one store,
 * nothing to choose. Do not reintroduce a mode flag here; add a separate engine instead.
 */
import { SETTINGS_FILE, getBuiltinSessionsRoot, readJsonFile } from '@cockpit/shared-utils';
import { getSessionTitle } from '../state/globalState';
import { runBuiltinAgent, requireTextPrompt, type BuiltinAgentConfig } from './builtinAgent';
import { createOpenAiCompatModel } from './builtinAgent/model';
import type { ApiKeyStore } from './credentials';
import type { DispatchParams, EngineSpec } from './types';

/** Per-engine slice of settings.json. The API key is NOT here — see credentials.ts. */
export interface EngineModelSettings {
  /**
   * Chosen model id. Named `builtinModel` rather than `model` because `model` was the
   * removed SDK mode's key and still sits in existing settings.json files holding ids
   * from the Anthropic-compatible endpoint's namespace — ids the OpenAI-compatible one
   * may not serve. Reusing the name would silently adopt those.
   */
  builtinModel?: string;
  /**
   * Chosen region id, for providers served from more than one (see `regions`). Absent
   * means "never chosen" — the UI language picks the default. Sessions are NOT
   * region-scoped, so changing this leaves existing transcripts resumable.
   */
  region?: string;
}

interface CockpitSettings {
  engines?: Record<string, EngineModelSettings | undefined>;
  /** UI language: 'auto' | 'en' | 'zh'. Seeds the region default — see `regions.defaultFor`. */
  language?: string;
  [key: string]: unknown;
}

/** Where one account is served. */
export interface EngineEndpoints {
  /** OpenAI-compatible endpoint — chat, model list and quota all go here. */
  openAiBaseUrl: string;
}

export interface AnthropicCompatProvider {
  /** Engine id. Doubles as the settings key and the Built-in Agent store key. */
  name: string;
  /** Human-readable name, used in the "no API key" preflight error. */
  label: string;
  /** Endpoint for single-region providers, and the fallback for multi-region ones. */
  endpoints: EngineEndpoints;
  /**
   * Providers served from more than one region (GLM: open.bigmodel.cn vs api.z.ai).
   * The region only changes which host serves the request — the same key authenticates
   * on both — so it is a routing preference, not part of the account's identity.
   */
  regions?: {
    byId: Record<string, EngineEndpoints>;
    /** settings.language → region id, for accounts that never chose one explicitly. */
    defaultFor(language: string | undefined): string;
  };
  /** Fallback when a request carries no model and settings hold none. */
  defaultModel: string;
  apiKey: ApiKeyStore;
  /** Sampling temperature; `null` omits the field. See BuiltinAgentConfig. */
  builtinTemperature?: number | null;
}

async function readSettings(): Promise<CockpitSettings> {
  return readJsonFile<CockpitSettings>(SETTINGS_FILE, {});
}

/**
 * Which host serves this account: the region the user picked, else the one the UI
 * language implies. Language only seeds the DEFAULT — it is a display preference, and
 * letting it re-route live traffic every time someone switches language would move the
 * API calls to another country with no visible cause.
 *
 * Note `language` may be 'auto', which only the browser can resolve (navigator.language);
 * server-side it falls through to the provider's own default.
 */
export function resolveEndpoints(
  p: AnthropicCompatProvider,
  saved: EngineModelSettings,
  language: string | undefined,
): EngineEndpoints {
  if (!p.regions) return p.endpoints;
  const id = saved.region || p.regions.defaultFor(language);
  return p.regions.byId[id] ?? p.endpoints;
}

/** Same, reading settings itself — for the /api/<engine>/* routes, which have no ctx. */
export async function readEngineEndpoints(p: AnthropicCompatProvider): Promise<EngineEndpoints> {
  const settings = await readSettings();
  return resolveEndpoints(p, settings.engines?.[p.name] ?? {}, settings.language);
}

/** The live model list is the whitelist and the picker already filtered against it — take
 *  the first non-empty candidate and let the API reject an unknown id with its own
 *  message. */
function resolveModel(
  requested: string | undefined,
  saved: string | undefined,
  fallback: string,
): string {
  if (typeof requested === 'string' && requested.trim()) return requested.trim();
  if (saved && saved.trim()) return saved.trim();
  return fallback;
}

function buildConfig(
  p: AnthropicCompatProvider,
  apiKey: string,
  endpoints: EngineEndpoints,
): BuiltinAgentConfig {
  return {
    sessionsRoot: getBuiltinSessionsRoot(p.name),
    defaultModel: p.defaultModel,
    createModel: async (modelName) =>
      createOpenAiCompatModel({ baseURL: endpoints.openAiBaseUrl, apiKey, modelName }),
    ...(p.builtinTemperature !== undefined && { temperature: p.builtinTemperature }),
  };
}

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
      // The built-in loop has no image support — reject images-only messages here rather
      // than letting the runner receive an undefined prompt.
      const textCheck = requireTextPrompt(params);
      if (!textCheck.ok) return textCheck;
      params.model = resolveModel(
        typeof params.model === 'string' ? params.model : undefined,
        saved.builtinModel,
        p.defaultModel,
      );
      return { ok: true as const };
    },
    runner: {
      async run(ctx) {
        const apiKey = await p.apiKey.read(); // preflight guaranteed non-empty
        const settings = await readSettings();
        const saved = settings.engines?.[p.name] ?? {};
        const endpoints = resolveEndpoints(p, saved, settings.language);
        await runBuiltinAgent(ctx, buildConfig(p, apiKey, endpoints));
      },
      resolveTitle: (cwd, sessionId) => getSessionTitle(cwd, sessionId),
    },
  };
}
