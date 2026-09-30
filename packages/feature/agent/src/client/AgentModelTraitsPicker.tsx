'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import {
  ENGINE_MENU_CLASS,
  ENGINE_MENU_ROW_SELECTED,
  EngineCheck,
  EngineIcon,
  EnginePickerTrigger,
} from './engineAccents';
import { formatCodexModelLabel, formatModelLabel } from './modelLabel';
import type {
  ChatEngine,
  ClaudeEffort,
  ClaudeModelId,
  CodexModelId,
  CodexReasoningEffort,
} from './types';

export const DEFAULT_CLAUDE_MODEL: ClaudeModelId = 'claude-opus-5-5';
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'high';
export const DEFAULT_CODEX_MODEL: CodexModelId = 'gpt-6.1-sol';
export const DEFAULT_CODEX_REASONING_EFFORT: CodexReasoningEffort = 'low';

const CLAUDE_EFFORTS: ReadonlyArray<{ id: ClaudeEffort; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' },
  { id: 'ultracode', label: 'Ultracode' },
  { id: 'ultrathink', label: 'Ultrathink' },
];

const CLAUDE_MODELS: ReadonlyArray<{
  id: ClaudeModelId;
  label: string;
  effort?: ReadonlyArray<ClaudeEffort>;
  defaultEffort?: ClaudeEffort;
  thinking?: boolean;
  fast?: boolean;
}> = [
  {
    id: 'claude-sonnet-5-5',
    label: 'Claude Sonnet 5.5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
    // Claude Code's own default for Sonnet 5.5 is `medium`, like Opus 5.5.
    defaultEffort: 'medium',
  },
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'],
    defaultEffort: 'high',
  },
  {
    id: 'claude-opus-5-5',
    label: 'Claude Opus 5.5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
    // `medium`, not `high`: Opus 5.5 is the one model in the lineup whose own
    // default is a step lower, and Claude Code follows it. A top-level
    // `effortLevel` deliberately does not carry over to this model.
    defaultEffort: 'medium',
    fast: true,
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
    defaultEffort: 'high',
    fast: true,
  },
  {
    id: 'claude-fable-5-1',
    label: 'Claude Fable 5.1',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
    defaultEffort: 'high',
  },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', thinking: true },
];

const CODEX_REASONING: ReadonlyArray<{ id: CodexReasoningEffort; label: string }> = [
  { id: 'low', label: 'Low' },
  { id: 'medium', label: 'Medium' },
  { id: 'high', label: 'High' },
  { id: 'xhigh', label: 'Extra High' },
  { id: 'max', label: 'Max' },
  { id: 'ultra', label: 'Ultra' },
];

const CODEX_MODELS: ReadonlyArray<{
  id: CodexModelId;
  label: string;
  reasoning: ReadonlyArray<CodexReasoningEffort>;
  defaultReasoning: CodexReasoningEffort;
}> = [
  // Labels, effort sets and defaults mirror the model catalog codex ships in
  // its own binary, so a row here says what codex itself would say. `ultra` is
  // per-model there and Luna does not have it.
  {
    id: 'gpt-6-astra',
    label: 'GPT-6-Astra',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoning: 'low',
  },
  {
    id: 'gpt-6.1-sol',
    label: 'GPT-6.1-Sol',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoning: 'low',
  },
  {
    id: 'gpt-6-sol',
    label: 'GPT-6-Sol',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoning: 'medium',
  },
  {
    id: 'gpt-6-luna',
    label: 'GPT-6-Luna',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoning: 'medium',
  },
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoning: 'low',
  },
];

export function defaultCodexReasoningEffort(model: CodexModelId): CodexReasoningEffort {
  return CODEX_MODELS.find((candidate) => candidate.id === model)?.defaultReasoning ?? DEFAULT_CODEX_REASONING_EFFORT;
}

export function resolveCodexReasoningEffortForModel(
  model: CodexModelId,
  effort: CodexReasoningEffort | undefined,
): CodexReasoningEffort {
  const supported = CODEX_MODELS.find((candidate) => candidate.id === model)?.reasoning;
  if (effort && (!supported || supported.includes(effort))) return effort;
  return defaultCodexReasoningEffort(model);
}

function codexReasoningOptions(model: CodexModelId): ReadonlyArray<{ id: CodexReasoningEffort; label: string }> {
  const supported = CODEX_MODELS.find((candidate) => candidate.id === model)?.reasoning;
  if (!supported) return CODEX_REASONING;
  return supported.map((id) => CODEX_REASONING.find((option) => option.id === id) ?? { id, label: id });
}

interface AgentModelTraitsPickerProps {
  engine: Extract<ChatEngine, 'claude' | 'codex'> | undefined;
  claudeModel?: ClaudeModelId;
  onClaudeModelChange?: (model: ClaudeModelId) => void;
  claudeEffort?: ClaudeEffort;
  onClaudeEffortChange?: (effort: ClaudeEffort) => void;
  claudeFastMode?: boolean;
  onClaudeFastModeChange?: (fastMode: boolean) => void;
  claudeThinking?: boolean;
  onClaudeThinkingChange?: (thinking: boolean) => void;
  codexModel?: CodexModelId;
  onCodexModelChange?: (model: CodexModelId) => void;
  codexReasoningEffort?: CodexReasoningEffort;
  onCodexReasoningEffortChange?: (effort: CodexReasoningEffort) => void;
}

function optionLabel<T extends string>(options: ReadonlyArray<{ id: T; label: string }>, value: T): string {
  return options.find((option) => option.id === value)?.label ?? value;
}

function codexModelLabel(model: CodexModelId): string {
  return CODEX_MODELS.find((candidate) => candidate.id === model)?.label ?? formatCodexModelLabel(model);
}

function claudeModelLabel(model: ClaudeModelId): string {
  const known = CLAUDE_MODELS.find((candidate) => candidate.id === model);
  if (known) return known.label;
  // A model dropped from the menu (superseded by a cheaper, stronger one) stays
  // pinned on the sessions already using it, so name it the same way the menu
  // would instead of leaking the raw id.
  return model.startsWith('claude-') ? `Claude ${formatModelLabel(model)}` : model;
}

function supportsFast(model: string): boolean {
  return CLAUDE_MODELS.find((m) => m.id === model)?.fast === true;
}

function supportsThinking(model: string): boolean {
  return CLAUDE_MODELS.find((m) => m.id === model)?.thinking === true;
}

export function defaultClaudeEffort(model: ClaudeModelId): ClaudeEffort | undefined {
  const descriptor = CLAUDE_MODELS.find((candidate) => candidate.id === model);
  return descriptor ? descriptor.defaultEffort : DEFAULT_CLAUDE_EFFORT;
}

export function resolveClaudeEffortForModel(
  model: ClaudeModelId,
  effort: ClaudeEffort | undefined,
): ClaudeEffort | undefined {
  const descriptor = CLAUDE_MODELS.find((candidate) => candidate.id === model);
  const supported = descriptor?.effort;
  if (effort && (!descriptor || supported?.includes(effort))) return effort;
  return defaultClaudeEffort(model);
}

function claudeEffortOptions(model: ClaudeModelId): ReadonlyArray<{ id: ClaudeEffort; label: string }> {
  const supported = CLAUDE_MODELS.find((candidate) => candidate.id === model)?.effort;
  if (!supported) return [];
  return supported.map((id) => CLAUDE_EFFORTS.find((option) => option.id === id) ?? { id, label: id });
}

function MenuRow<T extends string>({
  value,
  selected,
  label,
  defaultValue,
  onSelect,
}: {
  value: T;
  selected: boolean;
  label: string;
  defaultValue?: boolean;
  onSelect: (value: T) => void;
}) {
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={`flex w-full items-start gap-2 px-3 py-2 text-left text-xs transition-colors ${
        selected
          ? ENGINE_MENU_ROW_SELECTED
          : 'text-muted-foreground hover:bg-hover hover:text-foreground'
      }`}
    >
      <span className="mt-0.5">
        <EngineCheck selected={selected} />
      </span>
      <span className="min-w-0 flex-1 truncate">{label}</span>
      <span className="shrink-0">
        {defaultValue && (
          <span className="rounded bg-muted px-1.5 text-[10px] font-medium text-muted-foreground">
            Default
          </span>
        )}
      </span>
    </button>
  );
}

function TraitSelect<T extends string>({
  title,
  selected,
  value,
  items,
  onSelect,
  icon,
  testId,
}: {
  title: string;
  selected: T;
  value: string;
  items: ReadonlyArray<{ id: T; label: string; defaultValue?: boolean }>;
  onSelect: (value: T) => void;
  icon?: React.ReactNode;
  testId?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const panelTarget = usePanelPortalTarget();

  const updatePosition = () => {
    const rect = btnRef.current?.getBoundingClientRect();
    if (!rect) return;
    const origin = panelTarget?.getBoundingClientRect();
    const ox = origin?.left ?? 0;
    const oy = origin?.top ?? 0;
    setPos({ top: rect.bottom + 4 - oy, left: rect.left - ox });
  };

  const toggle = () => {
    if (!open) updatePosition();
    setOpen((v) => !v);
  };

  useEffect(() => {
    if (!open) return;
    const handlePointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (menuRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      setOpen(false);
    };
    const handleReposition = () => updatePosition();
    document.addEventListener('mousedown', handlePointerDown);
    window.addEventListener('resize', handleReposition);
    window.addEventListener('scroll', handleReposition, true);
    return () => {
      document.removeEventListener('mousedown', handlePointerDown);
      window.removeEventListener('resize', handleReposition);
      window.removeEventListener('scroll', handleReposition, true);
    };
  }, [open]);

  return (
    <div className="relative">
      <EnginePickerTrigger
        buttonRef={btnRef}
        label={value}
        labelMaxWidth="max-w-[180px]"
        title={`${title}: ${value}`}
        onClick={toggle}
        icon={icon}
        testId={testId}
      />
      {open && (
        <Portal>
          <div
            ref={menuRef}
            className={`${ENGINE_MENU_CLASS} min-w-[190px]`}
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="px-3 pb-1 text-[11px] font-medium text-muted-foreground">{title}</div>
            <div className="flex flex-col">
              {items.map((item) => (
                <MenuRow
                  key={item.id}
                  value={item.id}
                  selected={selected === item.id}
                  label={item.label}
                  defaultValue={item.defaultValue}
                  onSelect={(next) => {
                    onSelect(next);
                    setOpen(false);
                  }}
                />
              ))}
            </div>
          </div>
        </Portal>
      )}
    </div>
  );
}

export function AgentModelTraitsPicker(props: AgentModelTraitsPickerProps) {
  const engine = props.engine ?? 'claude';
  const isClaude = engine === 'claude';

  const claudeModel = props.claudeModel ?? DEFAULT_CLAUDE_MODEL;
  const claudeDefaultEffort = defaultClaudeEffort(claudeModel);
  const claudeSupportedEfforts = claudeEffortOptions(claudeModel);
  const claudeEffort = resolveClaudeEffortForModel(claudeModel, props.claudeEffort);
  const claudeFastMode = props.claudeFastMode ?? false;
  const claudeThinking = props.claudeThinking ?? false;
  const codexModel = props.codexModel ?? DEFAULT_CODEX_MODEL;
  const codexDefaultReasoningEffort = defaultCodexReasoningEffort(codexModel);
  const codexSupportedReasoning = codexReasoningOptions(codexModel);
  const codexReasoningEffort = resolveCodexReasoningEffortForModel(codexModel, props.codexReasoningEffort);

  const handleClaudeModel = (model: ClaudeModelId) => {
    props.onClaudeModelChange?.(model);
    const nextEffort = defaultClaudeEffort(model);
    if (nextEffort) props.onClaudeEffortChange?.(nextEffort);
    if (!supportsFast(model)) props.onClaudeFastModeChange?.(false);
    if (!supportsThinking(model)) props.onClaudeThinkingChange?.(false);
  };

  const handleCodexModel = (model: CodexModelId) => {
    props.onCodexModelChange?.(model);
    props.onCodexReasoningEffortChange?.(defaultCodexReasoningEffort(model));
  };

  if (!isClaude) {
    return (
      <div className="flex min-w-0 items-center gap-1" data-agent-model-traits>
        <TraitSelect
          title="Model"
          selected={codexModel}
          value={codexModelLabel(codexModel)}
          items={CODEX_MODELS.map((model) => ({
            id: model.id,
            label: model.label,
            defaultValue: model.id === DEFAULT_CODEX_MODEL,
          }))}
          onSelect={handleCodexModel}
          icon={<EngineIcon engine="codex" />}
          testId="codex-model-picker"
        />
        <TraitSelect
          title="Reasoning"
          selected={codexReasoningEffort}
          value={optionLabel(CODEX_REASONING, codexReasoningEffort)}
          items={codexSupportedReasoning.map((effort) => ({
            ...effort,
            defaultValue: effort.id === codexDefaultReasoningEffort,
          }))}
          onSelect={(value) => props.onCodexReasoningEffortChange?.(value)}
          testId="codex-reasoning-picker"
        />
      </div>
    );
  }

  return (
    <div className="flex min-w-0 items-center gap-1" data-agent-model-traits>
      <TraitSelect
        title="Model"
        selected={claudeModel}
        value={claudeModelLabel(claudeModel)}
        items={CLAUDE_MODELS.map((model) => ({
          id: model.id,
          label: model.label,
          defaultValue: model.id === DEFAULT_CLAUDE_MODEL,
        }))}
        onSelect={handleClaudeModel}
        icon={<EngineIcon engine="claude" />}
        testId="claude-model-picker"
      />
      {claudeEffort && claudeSupportedEfforts.length > 0 && (
        <TraitSelect
          title="Reasoning"
          selected={claudeEffort}
          value={optionLabel(CLAUDE_EFFORTS, claudeEffort)}
          items={claudeSupportedEfforts.map((effort) => ({
            ...effort,
            defaultValue: effort.id === claudeDefaultEffort,
          }))}
          onSelect={(value) => props.onClaudeEffortChange?.(value)}
          testId="claude-reasoning-picker"
        />
      )}
      {supportsFast(claudeModel) && (
        <TraitSelect
          title="Fast Mode"
          selected={claudeFastMode ? 'on' : 'off'}
          value={claudeFastMode ? 'Fast On' : 'Fast Off'}
          items={[
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off', defaultValue: true },
          ]}
          onSelect={(value) => props.onClaudeFastModeChange?.(value === 'on')}
          testId="claude-fast-mode-picker"
        />
      )}
      {supportsThinking(claudeModel) && (
        <TraitSelect
          title="Thinking"
          selected={claudeThinking ? 'on' : 'off'}
          value={claudeThinking ? 'Thinking On' : 'Thinking Off'}
          items={[
            { id: 'on', label: 'On' },
            { id: 'off', label: 'Off', defaultValue: true },
          ]}
          onSelect={(value) => props.onClaudeThinkingChange?.(value === 'on')}
          testId="claude-thinking-picker"
        />
      )}
    </div>
  );
}
