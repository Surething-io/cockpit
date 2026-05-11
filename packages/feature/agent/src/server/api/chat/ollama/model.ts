import { createOpenAI } from '@ai-sdk/openai';
import type { LanguageModelV3 } from '@ai-sdk/provider';
import { getOllamaOpenAIBaseURL } from '@cockpit/shared-utils';

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

export function createOllamaModel(modelName: string): LanguageModelV3 {
  const provider = createOpenAI({
    apiKey: process.env.OLLAMA_API_KEY || 'ollama',
    baseURL: getOllamaOpenAIBaseURL(),
    fetch: ollamaFetch,
  });
  return provider.chat(modelName);
}
