/**
 * /api/deepseek/models
 *
 * Model ids from DeepSeek's OpenAI-compatible /v1/models, used by the Built-in
 * Agent mode picker. Live rather than hardcoded: DeepSeek ships new models without
 * a cockpit release, and this is the only listing API it exposes (the
 * Anthropic-compatible endpoint SDK mode uses has none, hence the fixed
 * ALLOWED_MODELS pair in engines/deepseek.ts).
 *
 * Doubles as an API-key check — an invalid key fails here instead of at the first
 * chat turn.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { AgentError } from '@cockpit/effect-core';
import { readDeepseekApiKey } from '../../engines/deepseekCredentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const MODELS_URL = 'https://api.deepseek.com/v1/models';

interface OpenAIModel {
  id: string;
}

async function fetchModels(): Promise<string[]> {
  const apiKey = await readDeepseekApiKey();
  if (!apiKey) throw new Error('DeepSeek API key is not configured');

  const res = await fetch(MODELS_URL, {
    headers: { Authorization: `Bearer ${apiKey}` },
    signal: AbortSignal.timeout(8000),
  });
  if (!res.ok) throw new Error(`Server returned ${res.status}`);
  const data = (await res.json()) as { data?: OpenAIModel[] };
  return (data.data || []).map((m) => m.id).filter(Boolean);
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const models = yield* Effect.tryPromise({
      try: () => fetchModels(),
      catch: (cause) => {
        const msg = cause instanceof Error ? cause.message : String(cause);
        const kind = msg.includes('401') || msg.includes('API key')
          ? 'auth'
          : msg.includes('abort') || msg.includes('fetch failed')
            ? 'timeout'
            : 'protocol';
        return new AgentError({ provider: 'deepseek', kind, cause });
      },
    });
    return ok({ models });
  })
);
