/**
 * /api/glm/credentials — read/write the GLM (Zhipu BigModel) API key.
 * Behaviour lives in ../engineCredentials (shared with DeepSeek and Kimi).
 *
 * One key covers both regions: a key issued on open.bigmodel.cn authenticates on
 * api.z.ai and reports the same quota, so there is nothing region-specific to store
 * here (see engines/glm.ts).
 */
import { glmApiKey } from '../../engines/credentials';
import { makeCredentialsRoutes } from '../engineCredentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, PUT } = makeCredentialsRoutes(glmApiKey);
