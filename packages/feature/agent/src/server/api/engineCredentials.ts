/**
 * GET/PUT handlers for an engine's API key, shared by /api/deepseek/credentials
 * and /api/kimi/credentials.
 *
 * GET returns { hasKey, maskedKey } — the plaintext stays server-side. The one
 * exception is `?reveal=1`, which additionally returns `apiKey` so the picker's
 * Copy button can put the real value on the clipboard; there is no other way to
 * copy a key the UI only ever shows masked. It is opt-in per request so the
 * plaintext is not carried by the loads that happen on mount and on every
 * reopen. This leaks nothing the browser could not already get: cockpit is a
 * local server whose caller can equally read ~/.cockpit/<engine>/credentials.json.
 *
 * PUT { apiKey } persists it (empty string clears it).
 */
import { Effect } from 'effect';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import { FSError } from '@cockpit/effect-core';
import { maskApiKey, type ApiKeyStore } from '../engines/credentials';

export interface CredentialsInfo {
  hasKey: boolean;
  maskedKey: string;
  /** Plaintext key — present only on GET ?reveal=1. */
  apiKey?: string;
}

export function makeCredentialsRoutes(store: ApiKeyStore) {
  const toInfo = (key: string): CredentialsInfo => ({
    hasKey: !!key,
    maskedKey: maskApiKey(key),
  });

  const GET = handler((req) =>
    Effect.gen(function* () {
      const key = yield* Effect.tryPromise({
        try: () => store.read(),
        catch: (cause) => new FSError({ path: store.file, op: 'read', cause }),
      });
      const reveal = new URL(req.url).searchParams.get('reveal') === '1';
      return ok(reveal ? { ...toInfo(key), apiKey: key } : toInfo(key));
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
