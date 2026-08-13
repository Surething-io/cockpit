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
 * Where the engine's color lives now: the ICON, which is the real logo in the vendor's
 * own colors (public/agent-icons/*.svg), plus the live figures in ENGINE_TEXT_TONES.
 * Everything else — pill, popover, selected row, ✓, Save — is neutral and identical
 * across engines. Tinting those was tried and pulled: four trait pills in brand orange
 * made a settings strip the loudest thing on screen, and an orange-on-orange selected
 * row read as a warning rather than as the current value.
 *
 * So the rule for anything added here: color marks something that CHANGES or needs
 * acting on, never something that merely says which engine you are on — the logo
 * already does that, once, in the right place.
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

/**
 * Per-engine text tone, for FIGURES ONLY — the quota countdown and the DeepSeek
 * balance. Those change on their own and belong to one engine, so a hue that says
 * which engine is worth it there.
 *
 * Nothing else is tinted any more. The pickers used to carry this hue through the
 * pill, the popover's selected row, its ✓, its Save button and its focus ring, which
 * meant picking a model repainted half the panel in brand orange.
 *
 * The hues are deliberately NOT all brand colors — DeepSeek (#4D6BFE), Kimi (#1783FF)
 * and GLM (#3859FF) are essentially the same blue, so tinting by brand would make
 * three engines indistinguishable and contradict the sky/purple/amber chips those
 * same sessions carry in TabBar and EngineBadge. Brand fidelity lives on the logo.
 *
 * Tailwind classes must be literal strings — a `text-${engine}-400` template never
 * reaches the generated CSS.
 */
export const ENGINE_TEXT_TONES: Record<EngineAccentId, string> = {
  // Anthropic's brand orange. Not a Tailwind palette entry — amber is GLM's and
  // orange-500 is a good deal louder than the logo.
  claude: 'text-[#D97757]',
  // OpenAI green (#10A37F) rounded to emerald, matching the CX chip in TabBar.
  codex: 'text-emerald-400',
  deepseek: 'text-sky-400',
  kimi: 'text-purple-400',
  glm: 'text-amber-400',
  ollama: 'text-violet-400',
};

/**
 * The popover's own chrome — identical for every engine, on purpose.
 *
 * These were six tinted variants keyed off the engine. Selecting "Claude Opus 5" lit
 * the row up in brand orange on an orange wash, which reads as a warning state rather
 * than "this is the current value". Neutral surfaces plus the project's `brand` token
 * for the one real action (Save) put the emphasis back on the text.
 */
// font-medium, not just the wash: hover is bg-accent/60 on the same surface, so
// without a weight change "selected" and "the row under the cursor" look alike.
export const ENGINE_MENU_ROW_SELECTED = 'bg-accent font-medium text-foreground';
export const ENGINE_MENU_INPUT_FOCUS = 'focus:border-brand';
export const ENGINE_MENU_SAVE = 'bg-brand text-white hover:bg-brand/90';

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
export function EngineCheck({ selected }: { selected: boolean }) {
  return (
    <span className="flex h-3.5 w-3.5 flex-shrink-0 items-center justify-center text-foreground">
      {selected && <Check className="h-3.5 w-3.5" />}
    </span>
  );
}

interface EnginePickerTriggerProps {
  label: string;
  title: string;
  onClick: () => void;
  buttonRef?: React.Ref<HTMLButtonElement>;
  /** Logo — only the pill that names the engine carries one; trait pills do not. */
  icon?: React.ReactNode;
  /** For states that outrank the neutral default (e.g. "Set API key" in ENGINE_SETUP_TONE). */
  labelClassName?: string;
  labelMaxWidth?: string;
  testId?: string;
}

/**
 * The pill itself. One implementation, so a style change cannot reach five engines
 * and miss the sixth.
 *
 * Neutral by design and NOT engine-tinted: a Claude session shows four of these in a
 * row (model, reasoning, context, fast mode), and filling all four with the brand hue
 * made a settings strip shout louder than the conversation under it. Color here is
 * reserved for the exceptions — the vendor logo, and labelClassName for a state the
 * user must act on. The chevron inherits from the button so it follows the hover.
 */
export function EnginePickerTrigger({
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
      className="flex items-center gap-1 rounded px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
      title={title}
      data-testid={testId}
    >
      {icon}
      <span className={`truncate ${labelMaxWidth} ${labelClassName ?? ''}`}>{label}</span>
      <ChevronDown className="h-3 w-3 flex-shrink-0" />
    </button>
  );
}
