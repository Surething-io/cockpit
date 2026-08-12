'use client';

import { ENGINE_LABELS, EngineIcon, isEngineAccentId } from './engineAccents';

/**
 * EngineBadge — the marker naming the engine behind a session, tab or task.
 *
 * Every "list of things happening elsewhere" surface shows one (SessionBrowser,
 * ProjectSessionsModal, RecentSessionsModal, ScheduledTasksPanel,
 * GlobalSessionMonitor, TabBar), and they were independent copies of the same
 * ternary chain. They had already drifted: RecentSessionsModal's copy predated
 * DeepSeek, so a DeepSeek session rendered grey there and sky everywhere else;
 * TabBar spelled the engines as two-letter chips (CX / KM / GL / OL / DS) with a
 * sixth, separately-maintained color table.
 *
 * It is now the vendor logo — the same asset the engine's picker pill uses in the
 * chat top bar, so the mark you click to switch engines is the mark you scan for
 * in every list. Letters are gone: they needed a color to be told apart, which is
 * exactly what kept drifting.
 *
 * Claude is included. It used to be the unmarked default — every other engine was
 * chipped and Claude was inferred from the absence of a chip, which only reads if
 * you already know the rule.
 *
 * Deliberately dumb — it renders whatever engine it is handed, and an unknown one
 * falls back to a neutral text chip so a future engine is visible before it has art.
 */

interface EngineBadgeProps {
  /** Engine id; a missing value means the historical default (Claude). */
  engine?: string;
  /** Hover text — callers pass the model so the mark stays small but stays informative.
   *  Without one the engine name is used, which the icon alone no longer spells out. */
  tooltip?: string;
  /** 'sm' for dense rows (tab strip), 'md' for card headers. */
  size?: 'sm' | 'md';
}

export function EngineBadge({ engine, tooltip, size = 'md' }: EngineBadgeProps) {
  const resolved = engine || 'claude';

  if (!isEngineAccentId(resolved)) {
    return (
      <span
        className="shrink-0 px-1 py-0.5 text-[10px] leading-none font-medium rounded bg-muted text-muted-foreground"
        data-tooltip={tooltip ?? resolved}
      >
        {resolved}
      </span>
    );
  }

  return (
    <span className="shrink-0 inline-flex items-center" data-tooltip={tooltip ?? ENGINE_LABELS[resolved]}>
      <EngineIcon engine={resolved} className={size === 'sm' ? 'h-3 w-3' : 'h-3.5 w-3.5'} />
    </span>
  );
}
