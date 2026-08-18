/**
 * /api/kimi/models — live model list from Kimi Code's OpenAI-compatible
 * /coding/v1/models.
 *
 * Which models a key may call depends on its membership tier, so the list stays live.
 * Legacy coding ids remain runnable for saved sessions but are no longer offered in the
 * picker.
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
  hiddenModelIds: ['kimi-for-coding', 'kimi-for-coding-highspeed'],
});
