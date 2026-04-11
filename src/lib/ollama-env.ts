/**
 * Shared Ollama / LLM server URL resolution.
 *
 * Users set ONE env var: OLLAMA_BASE_URL — just the server root, no /v1/ suffix.
 *   e.g. http://127.0.0.1:11434
 *        http://10.0.0.30:1234
 *
 * If someone sets it WITH /v1/ by mistake, we strip it — be forgiving.
 */

const DEFAULT_BASE = 'http://127.0.0.1:11434';

/** Server root, never ends with /v1/ */
export function getBaseURL(): string {
  const raw = process.env.OLLAMA_BASE_URL || DEFAULT_BASE;
  return raw.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
}

/** OpenAI-compatible base URL (with /v1/) for AI SDK */
export function getOpenAIBaseURL(): string {
  return `${getBaseURL()}/v1/`;
}
