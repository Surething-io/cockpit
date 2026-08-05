/**
 * Per-engine API key storage.
 *
 * Each key lives in its own credential file under ~/.cockpit/<engine>/credentials.json,
 * deliberately separate from settings.json so it is never bundled into the
 * GET /api/settings payload that ships to the browser. Read/written only by the
 * engine (preflight/runner) and the /api/<engine>/credentials route.
 */
import {
  DEEPSEEK_CREDENTIALS_FILE,
  KIMI_CREDENTIALS_FILE,
  readJsonFile,
  writeJsonFile,
} from '@cockpit/shared-utils';

interface ApiKeyFile {
  apiKey?: string;
}

export interface ApiKeyStore {
  /** Absolute path of the backing file — routes report it in FSError. */
  readonly file: string;
  /** Read the raw key. Returns '' when unset. */
  read(): Promise<string>;
  /** Persist the key. An empty string clears it. */
  write(apiKey: string): Promise<void>;
}

function createApiKeyStore(file: string): ApiKeyStore {
  return {
    file,
    async read() {
      const creds = await readJsonFile<ApiKeyFile>(file, {});
      return creds.apiKey?.trim() ?? '';
    },
    async write(apiKey: string) {
      await writeJsonFile<ApiKeyFile>(file, { apiKey });
    },
  };
}

export const deepseekApiKey = createApiKeyStore(DEEPSEEK_CREDENTIALS_FILE);
export const kimiApiKey = createApiKeyStore(KIMI_CREDENTIALS_FILE);

/** Mask all but the last 4 chars, e.g. sk-1234abcd → sk-•••••bcd */
export function maskApiKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return key.replace(/./g, '•');
  return `${key.slice(0, 3)}${'•'.repeat(Math.max(4, key.length - 7))}${key.slice(-4)}`;
}
