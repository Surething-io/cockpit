'use client';

import React from 'react';
import { Check, ChevronDown } from 'lucide-react';
import type { ChatEngine } from './types';

/**
 * One visual language for every engine's top-bar picker.
 *
 * The row under ChatHeader used to render two unrelated designs: Claude/Codex were
 * transparent muted pills with a provider logo, while DeepSeek/Kimi/GLM/Ollama were
 * tinted pills with a colored dot. Same row, same job, two looks — and Ollama was a
 * hand-copied duplicate of the DeepSeek trigger, which is how its violet drifted out
 * of step with the blue in EngineBadge. Everything now goes through this module.
 *
 * Where brand fidelity lives: the ICON is the real logo in the vendor's own colors
 * (public/agent-icons/*.svg). The TINT is deliberately NOT always the brand hue —
 * DeepSeek (#4D6BFE), Kimi (#1783FF) and GLM (#3859FF) are all essentially the same
 * blue, so tinting by brand would make three engines indistinguishable and would
 * contradict the sky/purple/amber chips those same sessions already carry in TabBar
 * and EngineBadge. So: brand color on the logo, established per-engine hue on the
 * tint. Claude and Codex had no tint and no neighbour to collide with, so they get
 * their actual brand hues.
 */

/**
 * Aliased to ChatEngine rather than re-spelled, so adding a seventh engine fails to
 * compile here until it has a color, a label and (by the same edit) an icon under
 * public/agent-icons — instead of silently rendering as the neutral fallback in six
 * different lists, which is how DeepSeek once ended up grey in one modal and sky in
 * every other.
 */
export type EngineAccentId = ChatEngine;

/** Vendor casing, for tooltips and any prose that names the engine. */
export const ENGINE_LABELS: Record<EngineAccentId, string> = {
  claude: 'Claude',
  codex: 'Codex',
  deepseek: 'DeepSeek',
  kimi: 'Kimi',
  glm: 'GLM',
  ollama: 'Ollama',
};

export function isEngineAccentId(engine: string | undefined | null): engine is EngineAccentId {
  return !!engine && engine in ENGINE_LABELS;
}

/** Claude first (the default), then alphabetical. Typed as a full Record so a new
 *  engine has to be given a slot rather than quietly missing from the menus. */
const ENGINE_ORDER: Record<EngineAccentId, number> = {
  claude: 0,
  codex: 1,
  deepseek: 2,
  glm: 3,
  kimi: 4,
  ollama: 5,
};

/** Every engine, in the order any "pick an engine" list should offer them. */
export const ENGINE_IDS: EngineAccentId[] = (Object.keys(ENGINE_ORDER) as EngineAccentId[]).sort(
  (a, b) => ENGINE_ORDER[a] - ENGINE_ORDER[b],
);

/** Tailwind classes must be literal strings — a `bg-${accent}-500` template never
 *  reaches the generated CSS. */
export interface EngineAccent {
  /** Pill background, idle + hover. */
  trigger: string;
  /** Pill text. */
  label: string;
  /** Pill chevron. */
  chevron: string;
  /** Focus ring for text inputs inside this engine's popover. */
  inputFocus: string;
  /** Primary (Save) button inside the popover. */
  save: string;
  /** Selected row in the popover's list. */
  selectedRow: string;
  /** The ✓ marking the selected row. */
  check: string;
}

export const ENGINE_ACCENTS: Record<EngineAccentId, EngineAccent> = {
  // Anthropic's brand orange. Not a Tailwind palette entry — amber is GLM's and
  // orange-500 is a good deal louder than the logo.
  claude: {
    trigger: 'bg-[#D97757]/15 hover:bg-[#D97757]/25',
    label: 'text-[#D97757]',
    chevron: 'text-[#D97757]',
    inputFocus: 'focus:border-[#D97757]',
    save: 'bg-[#D97757]/20 hover:bg-[#D97757]/30 text-[#D97757]',
    selectedRow: 'bg-[#D97757]/15 text-[#D97757]',
    check: 'text-[#D97757]',
  },
  // OpenAI green (#10A37F) rounded to emerald, matching the CX chip in TabBar.
  codex: {
    trigger: 'bg-emerald-500/15 hover:bg-emerald-500/25',
    label: 'text-emerald-400',
    chevron: 'text-emerald-400',
    inputFocus: 'focus:border-emerald-500',
    save: 'bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300',
    selectedRow: 'bg-emerald-500/15 text-emerald-300',
    check: 'text-emerald-400',
  },
  deepseek: {
    trigger: 'bg-sky-500/15 hover:bg-sky-500/25',
    label: 'text-sky-400',
    chevron: 'text-sky-400',
    inputFocus: 'focus:border-sky-500',
    save: 'bg-sky-500/20 hover:bg-sky-500/30 text-sky-300',
    selectedRow: 'bg-sky-500/15 text-sky-300',
    check: 'text-sky-400',
  },
  kimi: {
    trigger: 'bg-purple-500/15 hover:bg-purple-500/25',
    label: 'text-purple-400',
    chevron: 'text-purple-400',
    inputFocus: 'focus:border-purple-500',
    save: 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300',
    selectedRow: 'bg-purple-500/15 text-purple-300',
    check: 'text-purple-400',
  },
  glm: {
    trigger: 'bg-amber-500/15 hover:bg-amber-500/25',
    label: 'text-amber-400',
    chevron: 'text-amber-400',
    inputFocus: 'focus:border-amber-500',
    save: 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300',
    selectedRow: 'bg-amber-500/15 text-amber-300',
    check: 'text-amber-400',
  },
  ollama: {
    trigger: 'bg-violet-500/15 hover:bg-violet-500/25',
    label: 'text-violet-400',
    chevron: 'text-violet-400',
    inputFocus: 'focus:border-violet-500',
    save: 'bg-violet-500/20 hover:bg-violet-500/30 text-violet-300',
    selectedRow: 'bg-violet-500/15 text-violet-300',
    check: 'text-violet-400',
  },
};

/**
 * Label tone for "this engine cannot run yet" (no API key saved).
 *
 * Deliberately a hue no engine owns. It used to be amber, which is GLM's accent — so
 * on GLM alone the warning rendered in exactly the color that pill uses when it is
 * healthy, and "Set API key" read like a model name. A warning that changes meaning
 * depending on which engine shows it is not a warning.
 *
 * Rose rather than the red used for request errors below it: nothing has failed, the
 * setup simply has not happened yet.
 */
export const ENGINE_SETUP_TONE = 'text-rose-400';

/**
 * Popover shell shared by every engine picker. Width is content-driven, so callers
 * append their own `min-w-*`; everything else (stacking, elevation, scroll cap) is
 * fixed here — the pickers used to disagree on z-index (1000 vs 9999) and shadow.
 */
export const ENGINE_MENU_CLASS =
  'fixed z-[9999] max-h-[70vh] overflow-y-auto rounded-lg border border-border bg-popover py-2 shadow-lg';

/** The vendor logo, in the vendor's colors. Every engine has one under /agent-icons. */
export function EngineIcon({
  engine,
  className = 'h-3.5 w-3.5',
}: {
  engine: EngineAccentId;
  className?: string;
}) {
  return (
    <img
      alt=""
      aria-hidden="true"
      src={`/agent-icons/${engine}.svg`}
      className={`${className} flex-shrink-0`}
    />
  );
}

/**
 * Fixed-width ✓ slot for list rows. Always occupies its space so labels do not
 * shift by 14px when the selection moves.
 */
export function EngineCheck({ selected, accent }: { selected: boolean; accent: EngineAccent }) {
  return (
    <span className={`flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center ${accent.check}`}>
      {selected && <Check className="h-3.5 w-3.5" />}
    </span>
  );
}

interface EnginePickerTriggerProps {
  accent: EngineAccent;
  label: string;
  title: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** Logo — only the pill that names the engine carries one; trait pills do not. */
  icon?: React.ReactNode;
  /** Overrides accent.label, for states that outrank the accent (e.g. "Set API key"). */
  labelClassName?: string;
  labelMaxWidth?: string;
  testId?: string;
}

/** The pill itself. One implementation, so a style change cannot reach five engines
 *  and miss the sixth. */
export function EnginePickerTrigger({
  accent,
  label,
  title,
  onClick,
  buttonRef,
  icon,
  labelClassName,
  labelMaxWidth = 'max-w-[160px]',
  testId,
}: EnginePickerTriggerProps) {
  return (
    <button
      ref={buttonRef}
      type="button"
      onClick={onClick}
      className={`flex items-center gap-1 rounded px-2 py-0.5 text-[11px] transition-colors ${accent.trigger}`}
      title={title}
      data-testid={testId}
    >
      {icon}
      <span className={`truncate ${labelMaxWidth} ${labelClassName ?? accent.label}`}>{label}</span>
      <ChevronDown className={`h-3 w-3 flex-shrink-0 ${accent.chevron}`} />
    </button>
  );
}
