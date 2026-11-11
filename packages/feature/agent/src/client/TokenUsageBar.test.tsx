import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { TokenUsageBar } from './TokenUsageBar';
import type { TokenUsage } from './types';

const usage = (over: Partial<TokenUsage>): TokenUsage => ({
  inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0, cacheCreationInputTokens: 0, totalCostUsd: 0, ...over,
} as TokenUsage);

const render = (u: TokenUsage, contextWindow?: number | null) =>
  renderToStaticMarkup(<TokenUsageBar tokenUsage={u} contextWindow={contextWindow} />);

describe('TokenUsageBar context figure', () => {
  // Grok session from the screenshot: prompt 19,691 + 2,176 cached, reply 41.
  const grok = usage({ inputTokens: 19691, cacheReadInputTokens: 2176, outputTokens: 41 });

  it('counts the reply, matching the context inspector\'s "used"', () => {
    expect(render(grok)).toContain('21,908');
  });

  it('shows used / window and the fill once the window is known', () => {
    const html = render(grok, 256000);
    expect(html).toContain('21.9K');
    expect(html).toContain(' / 256K');
    expect(html).toContain('9%');
    expect(html).toContain('bg-brand');
  });

  it('warns at 70% and turns critical at 90%', () => {
    expect(render(usage({ inputTokens: 180000 }), 256000)).toContain('bg-amber-9');
    expect(render(usage({ inputTokens: 240000 }), 256000)).toContain('bg-red-9');
  });

  it('keeps the plain figure when the window is unknown', () => {
    const html = render(grok, null);
    expect(html).not.toContain('%</strong>');
    expect(html).toContain('21,908');
  });
});
