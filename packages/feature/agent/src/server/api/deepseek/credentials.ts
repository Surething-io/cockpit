/**
 * /api/deepseek/credentials — read/write the DeepSeek API key.
 * Behaviour lives in ../engineCredentials (shared with Kimi).
 */
import { deepseekApiKey } from '../../engines/credentials';
import { makeCredentialsRoutes } from '../engineCredentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, PUT } = makeCredentialsRoutes(deepseekApiKey);
