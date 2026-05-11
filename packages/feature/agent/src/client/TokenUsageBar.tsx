'use client';

import React, { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import type { TokenUsage, RateLimitInfo } from './types';

// ============================================
// Token Usage Display
// ============================================
//
// Migrated from src/components/project/ChatHeader.tsx after agent types
// moved into this package (./types). See ChatHeader.tsx in this same
// directory for the original ChatHeader migration note.

interface TokenUsageBarProps {
  tokenUsage: TokenUsage;
  rateLimitInfo?: RateLimitInfo | null;
}

export function TokenUsageBar({ tokenUsage, rateLimitInfo }: TokenUsageBarProps) {
  const { t } = useTranslation();

  // "Now" updates every 30s so the countdown stays fresh without calling Date.now()
  // during render (which would violate react-hooks/purity).
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!rateLimitInfo?.resetsAt) return;
    const id = setInterval(() => setNow(Date.now()), 30000);
    return () => clearInterval(id);
  }, [rateLimitInfo?.resetsAt]);

  // Rate limit status styling
  const rateLimitColor = rateLimitInfo?.status === 'rejected'
    ? 'text-red-500'
    : rateLimitInfo?.status === 'allowed_warning'
      ? 'text-yellow-500'
      : 'text-muted-foreground';

  const rateLimitLabel = rateLimitInfo?.status === 'rejected'
    ? t('chat.rateLimitRejected', 'Rate Limited')
    : rateLimitInfo?.status === 'allowed_warning'
      ? t('chat.rateLimitWarning', 'Approaching Limit')
      : null;

  // Format reset time as countdown
  const formatResetTime = (resetsAt?: number) => {
    if (!resetsAt) return '';
    // resetsAt could be seconds or milliseconds — normalize
    const resetsAtMs = resetsAt < 1e12 ? resetsAt * 1000 : resetsAt;
    const diffMs = resetsAtMs - now;
    if (diffMs <= 0) return '';
    const diffMin = Math.ceil(diffMs / 60000);
    if (diffMin < 60) return `${diffMin}m`;
    const diffHr = Math.floor(diffMin / 60);
    const remainMin = diffMin % 60;
    return remainMin > 0 ? `${diffHr}h${remainMin}m` : `${diffHr}h`;
  };

  // Format rateLimitType for display
  const formatLimitType = (type?: string) => {
    if (!type) return '';
    return type.replace(/_/g, ' ');
  };

  return (
    <div className="px-4 py-1.5 border-t border-border bg-secondary">
      <div className="flex items-center justify-end gap-4 text-xs text-muted-foreground">
        {/* Rate limit warning/rejected indicator */}
        {rateLimitInfo && rateLimitLabel && (
          <span className={`flex items-center gap-1 ${rateLimitColor}`}
            title={[
              rateLimitInfo.rateLimitType && `Type: ${formatLimitType(rateLimitInfo.rateLimitType)}`,
              rateLimitInfo.utilization != null && `Usage: ${(rateLimitInfo.utilization * 100).toFixed(0)}%`,
              rateLimitInfo.resetsAt && `Resets in: ${formatResetTime(rateLimitInfo.resetsAt)}`,
              rateLimitInfo.isUsingOverage && 'Using overage',
            ].filter(Boolean).join(' · ')}
          >
            {rateLimitInfo.status === 'rejected' ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 9v2m0 4h.01m-6.938 4h13.856c1.54 0 2.502-1.667 1.732-3L13.732 4c-.77-1.333-2.694-1.333-3.464 0L3.34 16c-.77 1.333.192 3 1.732 3z" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8v4m0 4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
              </svg>
            )}
            <span>
              <strong>{rateLimitLabel}</strong>
              {rateLimitInfo.utilization != null && ` ${(rateLimitInfo.utilization * 100).toFixed(0)}%`}
              {rateLimitInfo.resetsAt && ` · ${formatResetTime(rateLimitInfo.resetsAt)}`}
            </span>
          </span>
        )}

        {/* Rate limit info (shown when allowed — display reset countdown) */}
        {rateLimitInfo && !rateLimitLabel && rateLimitInfo.resetsAt && (
          <span className="flex items-center gap-1.5"
            title={[
              rateLimitInfo.rateLimitType && formatLimitType(rateLimitInfo.rateLimitType),
              rateLimitInfo.utilization != null && `Usage: ${(rateLimitInfo.utilization * 100).toFixed(0)}%`,
              `Resets in: ${formatResetTime(rateLimitInfo.resetsAt)}`,
            ].filter(Boolean).join(' · ')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M13 10V3L4 14h7v7l9-11h-7z" />
            </svg>
            {rateLimitInfo.utilization != null
              ? <span>{(rateLimitInfo.utilization * 100).toFixed(0)}%</span>
              : <span>{formatResetTime(rateLimitInfo.resetsAt)}</span>
            }
          </span>
        )}

        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
          </svg>
          <span>{t('chat.context')}: <strong className="text-foreground">{(tokenUsage.inputTokens + tokenUsage.cacheReadInputTokens + tokenUsage.cacheCreationInputTokens).toLocaleString()}</strong></span>
        </span>
        <span className="flex items-center gap-1">
          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 10h.01M12 10h.01M16 10h.01M9 16H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-5l-5 5v-5z" />
          </svg>
          <span>{t('chat.output')}: <strong className="text-foreground">{tokenUsage.outputTokens.toLocaleString()}</strong></span>
        </span>
        {(tokenUsage.cacheReadInputTokens > 0 || tokenUsage.cacheCreationInputTokens > 0) && (
          <span className="flex items-center gap-1 text-brand">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 7v10c0 2.21 3.582 4 8 4s8-1.79 8-4V7M4 7c0 2.21 3.582 4 8 4s8-1.79 8-4M4 7c0-2.21 3.582-4 8-4s8 1.79 8 4" />
            </svg>
            <span>Cache: {((tokenUsage.cacheReadInputTokens / (tokenUsage.inputTokens + tokenUsage.cacheReadInputTokens + tokenUsage.cacheCreationInputTokens)) * 100).toFixed(0)}%</span>
          </span>
        )}
        {tokenUsage.totalCostUsd > 0 && (
          <span className="flex items-center gap-1 text-green-11">
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 8c-1.657 0-3 .895-3 2s1.343 2 3 2 3 .895 3 2-1.343 2-3 2m0-8c1.11 0 2.08.402 2.599 1M12 8V7m0 1v8m0 0v1m0-1c-1.11 0-2.08-.402-2.599-1M21 12a9 9 0 11-18 0 9 9 0 0118 0z" />
            </svg>
            <span>${tokenUsage.totalCostUsd.toFixed(4)}</span>
          </span>
        )}
      </div>
    </div>
  );
}
