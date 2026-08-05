/**
 * Shared plumbing for the small provider-console endpoints (model lists, balance,
 * quota) behind /api/<engine>/*.
 *
 * These are proxied rather than called from the browser: the API key lives in
 * ~/.cockpit/<engine>/credentials.json and is never handed to the client, so only
 * the server can authenticate them.
 */
import { AgentError } from '@cockpit/effect-core';
import type { ApiKeyStore } from '../engines/credentials';

const TIMEOUT_MS = 8000;

/** Map a thrown fetch/parse failure onto AgentError's `kind`. */
export function agentErrorKind(cause: unknown): 'auth' | 'timeout' | 'protocol' {
  const msg = cause instanceof Error ? cause.message : String(cause);
  if (msg.includes('401') || msg.includes('403') || msg.includes('API key')) return 'auth';
  if (msg.includes('abort') || msg.includes('fetch failed')) return 'timeout';
  return 'protocol';
}

/**
 * GET a provider JSON endpoint with the stored key as a Bearer token. Doubles as an
 * API-key check — an invalid key fails here instead of at the first chat turn.
 */
export async function getJsonWithKey<T>(opts: {
  url: string;
  store: ApiKeyStore;
  /** Provider name for the "not configured" message, e.g. 'Kimi'. */
  label: string;
}): Promise<T> {
  const apiKey = await opts.store.read();
  if (!apiKey) throw new Error(`${opts.label} API key is not configured`);

  const res = await fetch(opts.url, {
    headers: { Accept: 'application/json', Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  return (await res.json()) as T;
}

export { AgentError };
