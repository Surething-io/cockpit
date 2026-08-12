'use client';

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronDown } from 'lucide-react';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import type {
  ChatEngine,
  ClaudeContextWindow,
  ClaudeEffort,
  ClaudeModelId,
  CodexModelId,
  CodexReasoningEffort,
} from './types';

export const DEFAULT_CLAUDE_MODEL: ClaudeModelId = 'claude-opus-5';
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = 'high';
export const DEFAULT_CLAUDE_CONTEXT_WINDOW: ClaudeContextWindow = '200k';
export const DEFAULT_CODEX_MODEL: CodexModelId = 'gpt-5.6-sol';
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
  context?: ReadonlyArray<ClaudeContextWindow>;
  defaultContext?: ClaudeContextWindow;
  thinking?: boolean;
  fast?: boolean;
}> = [
  {
    id: 'claude-sonnet-5',
    label: 'Claude Sonnet 5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'],
    defaultEffort: 'high',
    context: ['200k', '1m'],
    defaultContext: '200k',
  },
  {
    id: 'claude-opus-5',
    label: 'Claude Opus 5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
    defaultEffort: 'high',
    context: ['200k', '1m'],
    defaultContext: '1m',
    fast: true,
  },
  {
    id: 'claude-fable-5',
    label: 'Claude Fable 5',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
    defaultEffort: 'high',
    context: ['200k', '1m'],
    defaultContext: '1m',
  },
  {
    id: 'claude-opus-4-8',
    label: 'Claude Opus 4.8',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultracode', 'ultrathink'],
    defaultEffort: 'high',
    fast: true,
  },
  {
    id: 'claude-opus-4-7',
    label: 'Claude Opus 4.7',
    effort: ['low', 'medium', 'high', 'xhigh', 'max', 'ultrathink'],
    defaultEffort: 'xhigh',
    fast: true,
  },
  {
    id: 'claude-opus-4-6',
    label: 'Claude Opus 4.6',
    effort: ['low', 'medium', 'high', 'max', 'ultrathink'],
    defaultEffort: 'high',
    context: ['200k', '1m'],
    defaultContext: '1m',
    fast: true,
  },
  {
    id: 'claude-sonnet-4-6',
    label: 'Claude Sonnet 4.6',
    effort: ['low', 'medium', 'high', 'max', 'ultrathink'],
    defaultEffort: 'high',
    context: ['200k', '1m'],
    defaultContext: '200k',
  },
  { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5', thinking: true },
];

const CODEX_REASONING: ReadonlyArray<{ id: CodexReasoningEffort; label: string }> = [
  { id: 'minimal', label: 'Minimal' },
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
  {
    id: 'gpt-5.6-sol',
    label: 'GPT-5.6-Sol',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoning: 'low',
  },
  {
    id: 'gpt-5.6-terra',
    label: 'GPT-5.6-Terra',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max', 'ultra'],
    defaultReasoning: 'medium',
  },
  {
    id: 'gpt-5.6-luna',
    label: 'GPT-5.6-Luna',
    reasoning: ['low', 'medium', 'high', 'xhigh', 'max'],
    defaultReasoning: 'medium',
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
  claudeContextWindow?: ClaudeContextWindow;
  onClaudeContextWindowChange?: (contextWindow: ClaudeContextWindow) => void;
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

function supportsContext(model: string): boolean {
  return !!CLAUDE_MODELS.find((m) => m.id === model)?.context?.length;
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

export function defaultClaudeContextWindow(model: ClaudeModelId): ClaudeContextWindow | undefined {
  const descriptor = CLAUDE_MODELS.find((candidate) => candidate.id === model);
  return descriptor ? descriptor.defaultContext : DEFAULT_CLAUDE_CONTEXT_WINDOW;
}

export function resolveClaudeContextWindowForModel(
  model: ClaudeModelId,
  contextWindow: ClaudeContextWindow | undefined,
): ClaudeContextWindow | undefined {
  const descriptor = CLAUDE_MODELS.find((candidate) => candidate.id === model);
  const supported = descriptor?.context;
  if (contextWindow && (!descriptor || supported?.includes(contextWindow))) return contextWindow;
  return defaultClaudeContextWindow(model);
}

function claudeEffortOptions(model: ClaudeModelId): ReadonlyArray<{ id: ClaudeEffort; label: string }> {
  const supported = CLAUDE_MODELS.find((candidate) => candidate.id === model)?.effort;
  if (!supported) return [];
  return supported.map((id) => CLAUDE_EFFORTS.find((option) => option.id === id) ?? { id, label: id });
}

function claudeContextOptions(model: ClaudeModelId): ReadonlyArray<ClaudeContextWindow> {
  return CLAUDE_MODELS.find((candidate) => candidate.id === model)?.context ?? [];
}

function ProviderIcon({ engine }: { engine: 'claude' | 'codex' }) {
  return (
    <img
      alt=""
      aria-hidden="true"
      src={`/agent-icons/${engine}.svg`}
      className="h-3.5 w-3.5 flex-shrink-0"
    />
  );
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
        selected ? 'text-foreground' : 'text-muted-foreground hover:bg-accent/60 hover:text-foreground'
      }`}
    >
      <span className="mt-0.5 flex h-3.5 w-3.5 items-center justify-center text-brand">
        {selected && <Check className="h-3.5 w-3.5" />}
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
      <button
        ref={btnRef}
        type="button"
        onClick={toggle}
        className="flex max-w-[220px] items-center gap-1 rounded-md px-2 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        title={`${title}: ${value}`}
        data-testid={testId}
      >
        {icon}
        <span className="truncate">{value}</span>
        <ChevronDown className="h-3 w-3 flex-shrink-0" />
      </button>
      {open && (
        <Portal>
          <div
            ref={menuRef}
            className="fixed z-[1000] max-h-[70vh] min-w-[190px] overflow-y-auto rounded-lg border border-border bg-popover py-1 shadow-xl"
            style={{ top: pos.top, left: pos.left }}
          >
            <div className="px-3 pb-1 pt-2 text-[11px] font-medium text-muted-foreground">{title}</div>
            <div className="flex flex-col pb-1">
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
  const claudeDefaultContextWindow = defaultClaudeContextWindow(claudeModel);
  const claudeSupportedContextWindows = claudeContextOptions(claudeModel);
  const claudeContextWindow = resolveClaudeContextWindowForModel(claudeModel, props.claudeContextWindow);
  const claudeFastMode = props.claudeFastMode ?? false;
  const claudeThinking = props.claudeThinking ?? false;
  const codexModel = props.codexModel ?? DEFAULT_CODEX_MODEL;
  const codexDefaultReasoningEffort = defaultCodexReasoningEffort(codexModel);
  const codexSupportedReasoning = codexReasoningOptions(codexModel);
  const codexReasoningEffort = resolveCodexReasoningEffortForModel(codexModel, props.codexReasoningEffort);

  const handleClaudeModel = (model: ClaudeModelId) => {
    props.onClaudeModelChange?.(model);
    const nextEffort = defaultClaudeEffort(model);
    const nextContextWindow = defaultClaudeContextWindow(model);
    if (nextEffort) props.onClaudeEffortChange?.(nextEffort);
    if (nextContextWindow) props.onClaudeContextWindowChange?.(nextContextWindow);
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
          value={optionLabel(CODEX_MODELS, codexModel)}
          items={CODEX_MODELS.map((model) => ({
            id: model.id,
            label: model.label,
            defaultValue: model.id === DEFAULT_CODEX_MODEL,
          }))}
          onSelect={handleCodexModel}
          icon={<ProviderIcon engine="codex" />}
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
        value={optionLabel(CLAUDE_MODELS, claudeModel)}
        items={CLAUDE_MODELS.map((model) => ({
          id: model.id,
          label: model.label,
          defaultValue: model.id === DEFAULT_CLAUDE_MODEL,
        }))}
        onSelect={handleClaudeModel}
        icon={<ProviderIcon engine="claude" />}
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
      {claudeContextWindow && claudeSupportedContextWindows.length > 0 && (
        <TraitSelect
          title="Context Window"
          selected={claudeContextWindow}
          value={claudeContextWindow === '1m' ? '1M' : '200K'}
          items={claudeSupportedContextWindows.map((contextWindow) => ({
            id: contextWindow,
            label: contextWindow === '1m' ? '1M' : '200K',
            defaultValue: contextWindow === claudeDefaultContextWindow,
          }))}
          onSelect={(value) => props.onClaudeContextWindowChange?.(value)}
          testId="claude-context-picker"
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
