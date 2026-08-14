'use client';

/**
 * Remaining plan allowance for the subscription engines (Kimi, GLM), shown inline on
 * the execution-mode row.
 *
 * Deliberately separate from DeepseekBalanceButton: DeepSeek reports prepaid credit
 * (one number per currency, no reset), while these report an allowance against
 * several time windows at once (a plan cycle plus a rolling short one), each with
 * its own reset time. One component covering both concepts would express neither
 * well — whereas Kimi and GLM really are the same concept, normalised server-side
 * into EngineQuotaPayload.
 *
 * On demand rather than polled, for the same reason as the balance button: a
 * background poll on every open tab would hit the provider for a number nobody is
 * watching.
 *
 * Quota belongs to the API key, so nothing about the chat state gates this.
 *
 * `hasKey` comes from Chat (fed by EngineConfigPicker) rather than being read here:
 * a locally-cached copy would go stale the moment the user saves a key.
 */

import React, { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { ENGINE_TEXT_TONES } from './engineAccents';
import {
  loadEngineQuota,
  type EngineQuotaInfo,
  type EngineQuotaWindow,
  type QuotaEngine,
} from './effect/agentClient';

interface EngineQuotaButtonProps {
  engine: QuotaEngine;
  /** Whether an API key is persisted. Without one there is nothing to authenticate with. */
  hasKey: boolean;
}

/** Each provider's console — quota detail, plan changes, key management. */
const CONSOLE_URLS: Record<QuotaEngine, string> = {
  kimi: 'https://www.kimi.com/code/console',
  glm: 'https://bigmodel.cn/coding-plan/personal/usage',
};

/** '2026-08-12T07:55:59Z' → '8/12 15:55' in the viewer's own timezone. The API reports
 *  UTC, and a reset time is only actionable if you can compare it to your own clock. */
function formatReset(iso: string | null): string | null {
  if (!iso) return null;
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return `${d.getMonth() + 1}/${d.getDate()} ${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
}

/** 'plan 100/100' — the label carries the window ('plan', '5h'), so the number needs no unit. */
function formatWindow(w: EngineQuotaWindow): string {
  const remaining = w.remaining ?? '?';
  const limit = w.limit ?? '?';
  return `${w.label} ${remaining}/${limit}`;
}

export function EngineQuotaButton({ engine, hasKey }: EngineQuotaButtonProps) {
  const { t } = useTranslation();
  const [loading, setLoading] = useState(false);
  const [usage, setUsage] = useState<EngineQuotaInfo | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleClick = useCallback(async () => {
    setLoading(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(loadEngineQuota(engine));
    if (exit._tag === 'Failure') {
      setUsage(null);
      // Both quota endpoints are undocumented (they are what the vendors' own CLIs call), and
      // GLM answers a pay-as-you-go key with "no coding plan" — a normal account state, not a
      // bug. So a failure here may mean bad key, no plan, or a changed endpoint. Say the
      // actionable one and leave the console link for the rest.
      setError(t('chat.quotaFailed', { defaultValue: 'Quota unavailable — check the API key' }));
    } else {
      setUsage(exit.value);
    }
    setLoading(false);
  }, [t, engine]);

  const windows = usage?.windows ?? [];
  // Tier first ('TRIAL', 'lite'): the same numbers mean different things per plan.
  const text = [usage?.tier, ...windows.map(formatWindow)].filter(Boolean).join(' · ');
  // Show the FURTHEST reset — that is the plan cycle, the one worth planning around; the
  // rolling short window refills within hours. Picked by timestamp rather than by position
  // or label, because the two providers disagree on both: Kimi returns [plan, 5h] and calls
  // the cycle 'plan', GLM returns [5h, 1w] and names it by duration.
  const reset = formatReset(
    windows.reduce<string | null>(
      (latest, w) => (w.resetTime && (!latest || w.resetTime > latest) ? w.resetTime : latest),
      null,
    ),
  );
  const exhausted = windows.some((w) => w.remaining === 0);

  return (
    <div className="ml-auto flex items-center gap-2">
      {loading && (
        <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
      )}
      {!loading && error && <span className="text-xs text-red-11">{error}</span>}
      {!loading && !error && usage && (
        <span
          className={`text-xs font-mono ${exhausted ? 'text-red-11' : ENGINE_TEXT_TONES[engine]}`}
          data-tooltip={
            reset
              ? t('chat.quotaResetAt', { defaultValue: 'Resets {{time}}', time: reset })
              : undefined
          }
          data-testid={`${engine}-quota-value`}
        >
          {text || t('chat.quotaEmpty', { defaultValue: 'No quota returned' })}
        </span>
      )}
      <button
        type="button"
        data-testid={`${engine}-quota-button`}
        disabled={!hasKey || loading}
        onClick={handleClick}
        data-tooltip={
          hasKey
            ? undefined
            : t('chat.quotaNeedsKey', { defaultValue: 'Set an API key first' })
        }
        className="px-2 py-0.5 text-xs rounded border border-border text-muted-foreground hover:bg-hover hover:text-foreground transition-colors disabled:opacity-40 disabled:cursor-not-allowed disabled:hover:bg-transparent"
      >
        {t('chat.checkQuota', { defaultValue: 'Check quota' })}
      </button>
      {/* Escape hatch to the console (quota detail, plan changes). Always available — unlike
          the button it needs no key. `target="_blank"` matters beyond convention: navigating
          in place would take the whole Cockpit window with it. */}
      <a
        href={CONSOLE_URLS[engine]}
        target="_blank"
        rel="noopener"
        data-testid={`${engine}-console-link`}
        title={t('chat.openProviderConsole', { defaultValue: 'Open the provider console' })}
        aria-label={t('chat.openProviderConsole', { defaultValue: 'Open the provider console' })}
        className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
      >
        <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
        </svg>
      </a>
    </div>
  );
}
