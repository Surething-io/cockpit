'use client';

/**
 * Remaining Kimi Code quota, shown inline on the execution-mode row — the Kimi
 * counterpart of DeepseekBalanceButton, and deliberately a separate component:
 * DeepSeek reports a prepaid balance (one number per currency), Kimi reports a
 * subscription allowance against several time windows at once (the plan cycle plus
 * a rolling 5-hour cap), each with its own reset time. Rendering the two through
 * one abstraction would mean an abstraction that can express neither well.
 *
 * On demand rather than polled, for the same reason as the balance button: a
 * background poll on every open tab would hit the provider for a number nobody is
 * watching.
 *
 * Quota belongs to the API key, not to the execution mode — SDK and Built-in Agent
 * authenticate with the same key — so this is NOT gated on `modeLocked`.
 *
 * `hasKey` comes from Chat (fed by EngineConfigPicker) rather than being read here:
 * a locally-cached copy would go stale the moment the user saves a key.
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadKimiUsage, type KimiUsageInfo, type KimiQuotaWindow } from './effect/agentClient';

interface KimiQuotaButtonProps {
  /** Whether an API key is persisted. Without one there is nothing to authenticate with. */
  hasKey: boolean;
}

/** Kimi Code's console — quota detail, plan changes, and key management. */
const CONSOLE_URL = 'https://www.kimi.com/code/console';

/** '2026-08-12T07:55:59Z' → '8/12 15:55' in the viewer's own timezone. The API reports
 *  UTC, and a reset time is only actionable if you can compare it to your own clock. */
function formatReset(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 'plan 100/100' — the label carries the window ('plan', '5h'), so the number needs no unit. */
function formatWindow(w: KimiQuotaWindow): string {
  const remaining = w.remaining ?? '?';
  const limit = w.limit ?? '?';
  return `${w.label} ${remaining}/${limit}`;
}

export function KimiQuotaButton({ hasKey }: KimiQuotaButtonProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<KimiUsageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setLoading(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(loadKimiUsage());
    if (exit._tag === 'Failure') {
      setUsage(null);
      // /coding/v1/usages is undocumented (it is what the Kimi CLI's own /usage calls), so a
      // failure here may equally mean "bad key" or "Kimi changed the endpoint". Say both.
      setError(t('chat.quotaFailed', { defaultValue: 'Quota unavailable — check the API key' }));
    } else {
      setUsage(exit.value);
    }
    setLoading(false);
  }, [t]);

  const windows = usage?.windows ?? [];
  const text = windows.map(formatWindow).join(' · ');
  // The plan window's reset is the one worth showing: the rolling window refills within hours.
  const reset = formatReset(windows.find((w) => w.label === 'plan')?.resetTime ?? null);
  const exhausted = windows.some((w) => w.remaining === 0);

  return (
    <div className="ml-auto flex items-center gap-2">
      {loading && (
        <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
      )}
      {!loading && error && <span className="text-xs text-red-400">{error}</span>}
      {!loading && !error && usage && (
        <span
          className={`text-xs font-mono ${exhausted ? 'text-red-400' : 'text-purple-400'}`}
          data-tooltip={
            reset
              ? t('chat.quotaResetAt', { defaultValue: 'Resets {{time}}', time: reset })
              : undefined
          }
          data-testid="kimi-quota-value"
        >
          {text || t('chat.quotaEmpty', { defaultValue: 'No quota returned' })}
        </span>
      )}
      <button
        type="button"
        data-testid="kimi-quota-button"
        disabled={!hasKey || loading}
        onClick={handleClick}
        data-tooltip={
          hasKey
            ? undefined
            : t('chat.quotaNeedsKey', { defaultValue: 'Set a Kimi API key first' })
        }
        className="px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:bg-accent hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        {t('chat.checkQuota', { defaultValue: 'Check quota' })}
      </button>
      {/* Escape hatch to the console (quota detail, plan changes). Always available — unlike
          the button it needs no key. `target="_blank"` matters beyond convention: navigating
          in place would take the whole Cockpit window with it. */}
      <a
        href={CONSOLE_URL}
        target="_blank"
        rel="noopener"
        data-testid="kimi-console-link"
        title={t('chat.openKimiConsole', { defaultValue: 'Open Kimi Code console' })}
        aria-label={t('chat.openKimiConsole', { defaultValue: 'Open Kimi Code console' })}
        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
    </div>
  );
}
