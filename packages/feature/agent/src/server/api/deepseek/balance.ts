/**
 * /api/deepseek/balance
 *
 * Account balance from DeepSeek's /user/balance. Proxied rather than called from
 * the browser: the API key lives in ~/.cockpit/deepseek/credentials.json and is
 * never handed to the client (see ./credentials.ts), so only the server can
 * authenticate this request.
 *
 * `is_available: false` is a normal 200 — the account exists but cannot serve
 * requests (out of credit / suspended). It is reported as data, not as an error,
 * so the UI can still show the (zero or negative) balance instead of a blank
 * failure. Only transport / auth failures become AgentError.
 *
 * `balance_infos` is a LIST — an account can hold CNY and USD at once. Return all
 * of them; picking [0] silently hides the other.
 */
import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { AgentError } from '@cockpit/effect-core';
import { deepseekApiKey } from '../../engines/credentials';
import { agentErrorKind, getJsonWithKey } from '../engineHttp';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const BALANCE_URL = 'https://api.deepseek.com/user/balance';

interface DeepseekBalanceInfo {
  currency?: string;
  total_balance?: string;
  granted_balance?: string;
  topped_up_balance?: string;
}

export interface BalanceEntry {
  currency: string;
  totalBalance: string;
}

export interface BalancePayload {
  isAvailable: boolean;
  balances: BalanceEntry[];
}

async function fetchBalance(): Promise<BalancePayload> {
  const data = await getJsonWithKey<{
    is_available?: boolean;
    balance_infos?: DeepseekBalanceInfo[];
  }>({ url: BALANCE_URL, store: deepseekApiKey, label: 'DeepSeek' });
  return {
    isAvailable: data.is_available !== false,
    balances: (data.balance_infos || [])
      .filter((b) => typeof b.total_balance === 'string')
      .map((b) => ({
        currency: b.currency || '',
        totalBalance: b.total_balance as string,
      })),
  };
}

export const GET = handler(() =>
  Effect.gen(function* () {
    const payload = yield* Effect.tryPromise({
      try: () => fetchBalance(),
      catch: (cause) =>
        new AgentError({ provider: 'deepseek', kind: agentErrorKind(cause), cause }),
    });
    return ok(payload);
  })
);
