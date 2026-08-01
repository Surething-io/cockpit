'use client';

/**
 * DeepSeek account balance, shown inline on the execution-mode row.
 *
 * Deliberately on demand rather than polled: the balance only moves when the
 * account spends, and a background poll on every open DeepSeek tab would hit
 * DeepSeek once per tab per interval for a number nobody is watching.
 *
 * Balance is a property of the API key, not of the execution mode — SDK and
 * Built-in Agent authenticate with the same key — so this is NOT gated on
 * `modeLocked` and stays usable after the session is locked.
 *
 * `hasKey` is passed down from Chat (fed by DeepseekConfigPicker) rather than
 * read here: a locally-cached copy would go stale the moment the user saves a
 * key in the picker, leaving this button disabled until the tab remounted.
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadDeepseekBalance, type DeepseekBalanceInfo } from './effect/agentClient';

interface DeepseekBalanceButtonProps {
  /** Whether an API key is persisted. Without one there is nothing to authenticate with. */
  hasKey: boolean;
}

const CURRENCY_SYMBOLS: Record<string, string> = { CNY: '¥', USD: '$' };

/** "110.00" + CNY → "¥110.00". Unknown currencies keep their code as the prefix. */
const formatBalance = (info: DeepseekBalanceInfo): string =>
  info.balances
    .map((b) => `${CURRENCY_SYMBOLS[b.currency] ?? (b.currency ? `${b.currency} ` : '')}${b.totalBalance}`)
    .join(' / ');

export function DeepseekBalanceButton({ hasKey }: DeepseekBalanceButtonProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [balance, setBalance] = useState<DeepseekBalanceInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setLoading(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(loadDeepseekBalance());
    if (exit._tag === 'Failure') {
      setBalance(null);
      setError(t('chat.balanceFailed', { defaultValue: 'Query failed — check the API key' }));
    } else {
      setBalance(exit.value);
    }
    setLoading(false);
  }, [t]);

  // An unavailable account still reports a number (often 0) — show it, in red, rather than
  // swallowing it behind a generic error. That distinction is the whole point of surfacing
  // `isAvailable` separately from the request outcome.
  const text = balance ? formatBalance(balance) : '';
  const unavailable = Boolean(balance && !balance.isAvailable);

  return (
    <div className="ml-auto flex items-center gap-2">
      {loading && (
        <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
      )}
      {!loading && error && <span className="text-xs text-red-400">{error}</span>}
      {!loading && !error && balance && (
        <span
          className={`text-xs font-mono ${unavailable ? 'text-red-400' : 'text-sky-400'}`}
          title={
            unavailable
              ? t('chat.balanceUnavailable', { defaultValue: 'Account is not available for requests' })
              : undefined
          }
          data-testid="deepseek-balance-value"
        >
          {text || t('chat.balanceEmpty', { defaultValue: 'No balance returned' })}
        </span>
      )}
      <button
        type="button"
        data-testid="deepseek-balance-button"
        disabled={!hasKey || loading}
        onClick={handleClick}
        title={
          hasKey
            ? undefined
            : t('chat.balanceNeedsKey', { defaultValue: 'Set a DeepSeek API key first' })
        }
        className="px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        {t('chat.checkBalance', { defaultValue: 'Check balance' })}
      </button>
    </div>
  );
}
