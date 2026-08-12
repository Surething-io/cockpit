/**
 * /api/deepseek/models — model ids from DeepSeek's OpenAI-compatible /v1/models,
 * which is the picker's whole list: there is no hardcoded whitelist to fall back on.
 *
 * Behaviour lives in ../engineModels (shared with Kimi and GLM).
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
