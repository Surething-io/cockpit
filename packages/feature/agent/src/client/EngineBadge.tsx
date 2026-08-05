'use client';

/**
 * EngineBadge — the small colored chip naming the engine behind a session or task.
 *
 * Every "list of things happening elsewhere" surface shows one (SessionBrowser,
 * ProjectSessionsModal, RecentSessionsModal, ScheduledTasksPanel), and they were
 * four independent copies of the same ternary chain. They had already drifted:
 * RecentSessionsModal's copy predated DeepSeek, so a DeepSeek session rendered
 * grey there and sky everywhere else.
 *
 * Deliberately dumb — it renders whatever engine it is handed. Whether the default
 * ('claude') is worth a badge is a per-surface call the CALLER makes: session lists
 * hide it as noise, the task board always shows it because a scheduled task fires
 * unattended and "which engine will run this" is the thing you came to check.
 */

/** Colors are per engine; 'claude' intentionally has no entry and takes the neutral fallback. */
const ENGINE_CLASS: Record<string, string> = {
  claude2: 'bg-orange-500/15 text-orange-11',
  ollama: 'bg-blue-500/15 text-blue-11',
  codex: 'bg-green-500/15 text-green-11',
  kimi: 'bg-purple-500/15 text-purple-11',
  // Amber — matches the GL chip in TabBar; the same session shows both.
  glm: 'bg-amber-500/15 text-amber-400',
  // Matches the DS badge in TabBar; the -11 scale has no sky token.
  deepseek: 'bg-sky-500/15 text-sky-400',
};

interface EngineBadgeProps {
  engine: string;
  /** Hover text — callers pass the model so the chip stays short but stays informative. */
  tooltip?: string;
}

export function EngineBadge({ engine, tooltip }: EngineBadgeProps) {
  return (
    <span
      className={`shrink-0 px-1 py-0.5 text-[10px] leading-none font-medium rounded ${
        ENGINE_CLASS[engine] ?? 'bg-muted text-muted-foreground'
      }`}
      data-tooltip={tooltip}
    >
      {engine}
    </span>
  );
}
