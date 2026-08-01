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

/** DeepSeek's console page for usage + top-up — everything /user/balance does not report. */
const USAGE_URL = 'https://platform.deepseek.com/usage';

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
          data-tooltip={
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
        data-tooltip={
          hasKey
            ? undefined
            : t('chat.balanceNeedsKey', { defaultValue: 'Set a DeepSeek API key first' })
        }
        className="px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        {t('chat.checkBalance', { defaultValue: 'Check balance' })}
      </button>
      {/* Escape hatch to the console (usage breakdown, top-up). Always available — unlike the
          button it needs no key, and a user with no balance is exactly who needs this link.
          `target="_blank"` matters here beyond convention: navigating in place would take the
          whole Cockpit window with it. */}
      <a
        href={USAGE_URL}
        target="_blank"
        rel="noopener"
        data-testid="deepseek-usage-link"
        title={t('chat.openUsagePage', { defaultValue: 'Open DeepSeek usage console' })}
        aria-label={t('chat.openUsagePage', { defaultValue: 'Open DeepSeek usage console' })}
        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
    </div>
  );
}
