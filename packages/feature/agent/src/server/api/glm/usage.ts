/**
 * /api/glm/usage
 *
 * Remaining GLM Coding Plan allowance, from GET /api/monitor/usage/quota/limit —
 * undocumented, and what the community quota tools call. The response shape and its
 * traps are documented in ./quota, which also holds the parsing: this file may export
 * nothing but the route handler (see that file's header).
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { AgentError } from '@cockpit/effect-core';
import { glmApiKey } from '../../engines/credentials';
import { readEngineEndpoints } from '../../engines/anthropicCompat';
import { glmProvider } from '../../engines/glm';
import { agentErrorKind, getJsonWithKey } from '../engineHttp';
import { toQuotaPayload, type RawQuota } from './quota';
import type { EngineQuotaPayload } from '../engineQuota';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function fetchQuota(): Promise<EngineQuotaPayload> {
  const { openAiBaseUrl } = await readEngineEndpoints(glmProvider);
  // The quota endpoint hangs off the host root, not the /coding/paas/v4 API prefix.
  const host = new URL(openAiBaseUrl).origin;
  return toQuotaPayload(
    await getJsonWithKey<RawQuota>({
      url: `${host}/api/monitor/usage/quota/limit`,
      store: glmApiKey,
      label: 'GLM',
    })
  );
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const payload = yield* Effect.tryPromise({
      try: () => fetchQuota(),
      catch: (cause) => new AgentError({ provider: 'glm', kind: agentErrorKind(cause), cause }),
    });
    return ok(payload);
  })
);
