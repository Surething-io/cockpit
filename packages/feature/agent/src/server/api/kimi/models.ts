/**
 * /api/kimi/models — live model list from Kimi Code's OpenAI-compatible
 * /coding/v1/models.
 *
 * Unlike DeepSeek this list drives BOTH modes: Kimi serves the same four ids over
 * the Anthropic- and OpenAI-compatible protocols, and which of them a key may call
 * depends on the membership tier — a hardcoded list would show tiers their plan
 * cannot run. The response also carries context_length and think_efforts, which
 * engines/kimi.ts turns into the SDK's context/effort env.
 *
 * Behaviour lives in ../engineModels (shared with DeepSeek).
 */
import { kimiApiKey } from '../../engines/credentials';
import { KIMI_OPENAI_BASE_URL } from '../../engines/kimi';
import { makeModelsRoute } from '../engineModels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = makeModelsRoute({
  provider: 'kimi',
  label: 'Kimi',
  url: `${KIMI_OPENAI_BASE_URL}/models`,
  store: kimiApiKey,
});
