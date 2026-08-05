/**
 * GET/PUT handlers for an engine's API key, shared by /api/deepseek/credentials
 * and /api/kimi/credentials.
 *
 * GET never returns the raw key — only { hasKey, maskedKey } — so the plaintext
 * stays server-side. PUT { apiKey } persists it (empty string clears it).
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { FSError } from '@cockpit/effect-core';
import { maskApiKey, type ApiKeyStore } from '../engines/credentials';

export interface CredentialsInfo {
  hasKey: boolean;
  maskedKey: string;
}

export function makeCredentialsRoutes(store: ApiKeyStore) {
  const toInfo = (key: string): CredentialsInfo => ({
    hasKey: !!key,
    maskedKey: maskApiKey(key),
  });

  const GET = handler(() =>
    Effect.gen(function* () {
      const key = yield* Effect.tryPromise({
        try: () => store.read(),
        catch: (cause) => new FSError({ path: store.file, op: 'read', cause }),
      });
      return ok(toInfo(key));
    })
  );

  const PUT = handler((req) =>
    Effect.gen(function* () {
      const body = (yield* parseJsonRaw(req)) as { apiKey?: unknown };
      const apiKey = typeof body.apiKey === 'string' ? body.apiKey.trim() : '';
      yield* Effect.tryPromise({
        try: () => store.write(apiKey),
        catch: (cause) => new FSError({ path: store.file, op: 'write', cause }),
      });
      return ok(toInfo(apiKey));
    })
  );

  return { GET, PUT };
}
