/**
 * /api/kimi/credentials — read/write the Kimi Code API key.
 * Behaviour lives in ../engineCredentials (shared with DeepSeek).
 */
import { kimiApiKey } from '../../engines/credentials';
import { makeCredentialsRoutes } from '../engineCredentials';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const { GET, PUT } = makeCredentialsRoutes(kimiApiKey);
