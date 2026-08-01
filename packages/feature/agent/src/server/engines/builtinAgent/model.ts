import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { resolveOllamaConnection } from '@cockpit/shared-utils';

/**
 * Ollama's OpenAI-compatible endpoint rejects assistant messages with
 * `content: null` (the standard OpenAI representation for tool-call-only
 * turns), responding with `invalid message content type: <nil>`.
 *
 * The AI SDK serializes assistant turns containing only tool-calls to
 * `content: null`, which is valid per OpenAI spec but not accepted here.
 * Coerce `null` → `""` on the wire to keep tool-heavy sessions working.
 */
const ollamaFetch: typeof fetch = async (input, init) => {
  if (init && typeof init.body === 'string') {
    try {
      const body = JSON.parse(init.body) as { messages?: unknown };
      if (Array.isArray(body.messages)) {
        let mutated = false;
        for (const m of body.messages as Array<{ role?: string; content?: unknown }>) {
          if (m && m.role === 'assistant' && m.content == null) {
            m.content = '';
            mutated = true;
          }
        }
        if (mutated) init = { ...init, body: JSON.stringify(body) };
      }
    } catch {
      // Body wasn't JSON or had unexpected shape — pass through unchanged.
    }
  }
  return fetch(input, init);
};

export async function createOllamaModel(modelName: string): Promise<LanguageModelV3> {
  // baseUrl + apiKey resolved by priority: config file (set via the chat-header
  // picker) > env (OLLAMA_BASE_URL / OLLAMA_API_KEY) > default. The apiKey is an
  // EFFECT.md §0 exemption (third-party plugin key, same category as
  // OPENAI_API_KEY / ANTHROPIC_API_KEY), so it is resolved here rather than via
  // CockpitConfig.
  const { baseUrl, apiKey } = await resolveOllamaConnection();
  const provider = createOpenAI({
    apiKey,
    baseURL: `${baseUrl}/v1/`,
    fetch: ollamaFetch,
  });
  return provider.chat(modelName);
}

/**
 * Any OpenAI-compatible chat-completions endpoint (DeepSeek's /v1, and whatever
 * provider gets a Built-in Agent mode next). No ollamaFetch here — the
 * `content: null` coercion is an Ollama server quirk, and hosted providers accept
 * the spec-compliant form.
 */
export function createOpenAiCompatModel(opts: {
  baseURL: string;
  apiKey: string;
  modelName: string;
}): LanguageModelV3 {
  const provider = createOpenAI({ apiKey: opts.apiKey, baseURL: opts.baseURL });
  return provider.chat(opts.modelName);
}
