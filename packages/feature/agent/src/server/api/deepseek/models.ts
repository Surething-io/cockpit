/**
 * /api/deepseek/models — model ids from DeepSeek's OpenAI-compatible /v1/models,
 * used by the Built-in Agent mode picker. SDK mode instead runs the fixed
 * ALLOWED_MODELS pair in engines/deepseek.ts, because the Anthropic-compatible
 * endpoint it talks to has no listing API.
 *
 * Behaviour lives in ../engineModels (shared with Kimi).
 */
import { deepseekApiKey } from '../../engines/credentials';
import { makeModelsRoute } from '../engineModels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = makeModelsRoute({
  provider: 'deepseek',
  label: 'DeepSeek',
  url: 'https://api.deepseek.com/v1/models',
  store: deepseekApiKey,
});
