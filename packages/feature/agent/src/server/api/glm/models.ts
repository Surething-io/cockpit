/**
 * /api/glm/models — live model list from GLM's OpenAI-compatible /models.
 *
 * The host follows the configured region, so the URL is a thunk rather than a
 * constant: the same account is served by open.bigmodel.cn and api.z.ai, and the
 * picker must list whichever one the user's runs will actually hit.
 *
 * GLM reports bare ids here — no display name, no context window — so the picker
 * shows ids only and engines/glm.ts sets no context env. That is a provider
 * limitation, not an oversight.
 */
import { glmApiKey } from '../../engines/credentials';
import { readEngineEndpoints } from '../../engines/anthropicCompat';
import { glmProvider } from '../../engines/glm';
import { makeModelsRoute } from '../engineModels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = makeModelsRoute({
  provider: 'glm',
  label: 'GLM',
  url: async () => `${(await readEngineEndpoints(glmProvider)).openAiBaseUrl}/models`,
  store: glmApiKey,
});
