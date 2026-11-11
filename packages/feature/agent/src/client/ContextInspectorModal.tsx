'use client';

import { memo, useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { useEscToClose, useTheme } from '@cockpit/shared-ui';
import { loadSessionContext } from './effect/agentClient';
import type { ContextCategory, ContextCategoryId, ContextItem, ContextSnapshot } from '../shared/contextSnapshot';

interface ContextInspectorModalProps {
  isOpen: boolean;
  onClose: () => void;
  cwd: string | null | undefined;
  sessionId: string | null | undefined;
}

// Eight fixed groups so a group keeps its hue in every session and engine
// (color follows the entity). Same validated palette as TokenStatsModal; the
// light set has three hues under 3:1 on the surface, which is why every
// segment is also named, with its number, in the legend and the list below.
type Group = 'prompt' | 'memory' | 'tools' | 'skills' | 'messages' | 'tool_io' | 'reasoning' | 'other';
const GROUPS: Group[] = ['prompt', 'memory', 'tools', 'skills', 'messages', 'tool_io', 'reasoning', 'other'];
const PALETTE = {
  light: ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#4a3aa7', '#e34948'],
  dark: ['#3987e5', '#d95926', '#199e70', '#c98500', '#d55181', '#008300', '#9085e9', '#e66767'],
};
const GROUP_OF: Record<ContextCategoryId, Group> = {
  system: 'prompt', instructions: 'prompt', environment: 'prompt',
  memory: 'memory', tools: 'tools', mcp: 'tools', skills: 'skills', agents: 'skills',
  messages: 'messages', summary: 'messages', tool_io: 'tool_io', reasoning: 'reasoning', other: 'other',
};

function fmt(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${Math.round(n / 1000)}K`;
  if (n >= 1_000) return `${(n / 1000).toFixed(1)}K`;
  return String(n);
}

const tokenLabel = (tokens: number | null, exact: boolean) => tokens === null ? '—' : `${exact ? '' : '≈'}${fmt(tokens)}`;

type Load = { status: 'idle' | 'loading' } | { status: 'error'; message: string } | { status: 'ready'; data: ContextSnapshot };

interface ItemRowProps {
  item: ContextItem;
  selected: boolean;
  onSelect: (id: string) => void;
}

const ItemRow = memo(function ItemRow({ item, selected, onSelect }: ItemRowProps) {
  return (
    <button
      onClick={() => onSelect(item.id)}
      className={`w-full flex items-center gap-2 pl-7 pr-3 py-1 text-left text-xs transition-colors ${selected ? 'bg-selected text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'}`}
    >
      <span className={`flex-1 truncate font-mono ${item.content === undefined ? 'opacity-60' : ''}`}>{item.label}</span>
      <span className="tabular-nums flex-shrink-0">{tokenLabel(item.tokens, item.exact ?? false)}</span>
    </button>
  );
});

interface CategoryBlockProps {
  category: ContextCategory;
  index: number;
  color: string;
  label: string;
  expanded: boolean;
  selectedKey: string | null;
  onToggle: (index: number) => void;
  onSelect: (key: string) => void;
}

const CategoryBlock = memo(function CategoryBlock({ category, index, color, label, expanded, selectedKey, onToggle, onSelect }: CategoryBlockProps) {
  const { t } = useTranslation();
  const select = useCallback((id: string) => onSelect(`${index}:${id}`), [index, onSelect]);
  return (
    <div className="border-b border-border last:border-b-0">
      <button onClick={() => onToggle(index)} className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-hover transition-colors">
        <svg className={`w-3 h-3 text-muted-foreground transition-transform flex-shrink-0 ${expanded ? 'rotate-90' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
        </svg>
        <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: color }} />
        <span className="flex-1 text-sm text-foreground truncate">{label}</span>
        <span className="text-[11px] text-muted-foreground flex-shrink-0">{t('contextInspector.items', { count: category.items.length })}</span>
        <span className="text-xs font-medium text-foreground tabular-nums w-14 text-right flex-shrink-0">{tokenLabel(category.tokens, category.exact)}</span>
      </button>
      {expanded && (
        <div className="pb-1">
          {category.items.map((item) => (
            <ItemRow key={item.id} item={item} selected={selectedKey === `${index}:${item.id}`} onSelect={select} />
          ))}
        </div>
      )}
    </div>
  );
});

export function ContextInspectorModal({ isOpen, onClose, cwd, sessionId }: ContextInspectorModalProps) {
  const { t, i18n } = useTranslation();
  const { resolvedTheme } = useTheme();
  const palette = PALETTE[resolvedTheme === 'dark' ? 'dark' : 'light'];
  const [load, setLoad] = useState<Load>({ status: 'idle' });
  const [expanded, setExpanded] = useState<Set<number>>(() => new Set());
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);
  const [copied, setCopied] = useState(false);
  useEscToClose(onClose, isOpen);

  useEffect(() => {
    if (!isOpen || !cwd || !sessionId) return;
    let cancelled = false;
    queueMicrotask(() => { if (!cancelled) setLoad({ status: 'loading' }); });
    BrowserRuntime.runPromiseExit(loadSessionContext(cwd, sessionId)).then((exit) => {
      if (cancelled) return;
      if (exit._tag === 'Success') setLoad({ status: 'ready', data: exit.value });
      else setLoad({ status: 'error', message: t('contextInspector.loadFailed') });
    });
    return () => { cancelled = true; };
  }, [isOpen, cwd, sessionId, nonce, t]);

  const data = load.status === 'ready' ? load.data : null;

  const groups = useMemo(() => {
    const totals = new Map<Group, number>();
    for (const c of data?.categories ?? []) totals.set(GROUP_OF[c.id], (totals.get(GROUP_OF[c.id]) ?? 0) + c.tokens);
    return GROUPS.map((g, i) => ({ group: g, color: palette[i], tokens: totals.get(g) ?? 0 })).filter((g) => g.tokens > 0);
  }, [data, palette]);

  const colorOf = useCallback((id: ContextCategoryId) => palette[GROUPS.indexOf(GROUP_OF[id])], [palette]);

  const toggle = useCallback((index: number) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(index)) next.delete(index); else next.add(index);
      return next;
    });
  }, []);
  const select = useCallback((key: string) => { setSelectedKey(key); setCopied(false); }, []);

  const selected = useMemo(() => {
    if (!data || !selectedKey) return null;
    const sep = selectedKey.indexOf(':');
    const category = data.categories[Number(selectedKey.slice(0, sep))];
    const item = category?.items.find((i) => i.id === selectedKey.slice(sep + 1));
    return category && item ? { category, item } : null;
  }, [data, selectedKey]);

  const copy = useCallback(() => {
    if (!selected?.item.content) return;
    navigator.clipboard.writeText(selected.item.content).then(() => setCopied(true), () => setCopied(false));
  }, [selected]);

  if (!isOpen) return null;

  const estimatedSum = groups.reduce((s, g) => s + g.tokens, 0);
  const used = data?.usedTokens ?? null;
  // Bar scale: the window when known; otherwise whatever is largest, so nothing overflows.
  const scale = Math.max(data?.contextWindow ?? 0, used ?? 0, estimatedSum, 1);
  const free = data?.contextWindow != null && used != null ? Math.max(0, data.contextWindow - used) : null;
  const categoryLabel = (c: ContextCategory) => c.name ?? t(`contextInspector.categories.${c.id}`);
  const capturedAt = data?.capturedAt ? new Date(data.capturedAt).toLocaleString(i18n.language) : null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div className="relative bg-card rounded-xl shadow-lv3 w-full max-w-6xl mx-4 h-[85vh] flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-border flex-shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <h2 className="text-sm font-medium text-foreground">{t('contextInspector.title')}</h2>
            {data && <span className="text-xs text-muted-foreground truncate">{data.engine}{data.model ? ` · ${data.model}` : ''}</span>}
          </div>
          <div className="flex items-center gap-1">
            <button onClick={() => setNonce((n) => n + 1)} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors">
              {t('contextInspector.refresh')}
            </button>
            <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors">
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {!sessionId ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">{t('contextInspector.noSession')}</div>
        ) : load.status === 'error' ? (
          <div className="flex-1 flex items-center justify-center text-sm text-red-11">{load.message}</div>
        ) : !data ? (
          <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">{t('common.loading')}</div>
        ) : (
          <>
            {/* Summary: provider total + window, then the per-group bar and its legend */}
            <div className="px-5 py-3 border-b border-border flex-shrink-0 space-y-2">
              <div className="flex items-baseline gap-4 text-xs text-muted-foreground">
                <span>{t('contextInspector.used')}: <strong className="text-foreground text-sm tabular-nums">{used === null ? '—' : used.toLocaleString()}</strong></span>
                <span>
                  {data.contextWindow
                    ? <>{t('contextInspector.window')}: <strong className="text-foreground tabular-nums">{data.contextWindow.toLocaleString()}</strong>{used !== null && ` (${Math.round((used / data.contextWindow) * 100)}%)`}</>
                    : t('contextInspector.unknownWindow')}
                </span>
                {free !== null && <span>{t('contextInspector.free')}: <span className="tabular-nums">{free.toLocaleString()}</span></span>}
                <span className="flex-1" />
                {capturedAt && <span>{t('contextInspector.capturedAt', { time: capturedAt })}</span>}
              </div>
              <div className="flex h-3 w-full rounded bg-muted overflow-hidden gap-[2px]">
                {groups.map((g) => (
                  <div
                    key={g.group}
                    className="h-full first:rounded-l last:rounded-r min-w-[2px]"
                    style={{ width: `${(g.tokens / scale) * 100}%`, backgroundColor: g.color }}
                    data-tooltip={`${t(`contextInspector.groups.${g.group}`)} · ${g.tokens.toLocaleString()}`}
                  />
                ))}
              </div>
              <div className="flex flex-wrap gap-x-4 gap-y-1 text-[11px] text-muted-foreground">
                {groups.map((g) => (
                  <span key={g.group} className="flex items-center gap-1.5">
                    <span className="w-2 h-2 rounded-sm" style={{ backgroundColor: g.color }} />
                    {t(`contextInspector.groups.${g.group}`)}
                    <span className="text-foreground tabular-nums">{fmt(g.tokens)}</span>
                  </span>
                ))}
              </div>
              {data.notes.length > 0 && (
                <ul className="text-[11px] text-muted-foreground space-y-0.5 list-disc pl-4">
                  {data.notes.map((note) => <li key={note}>{t(`contextInspector.notes.${note}`)}</li>)}
                </ul>
              )}
            </div>

            {/* Body: categories (left) and the selected item's content (right) */}
            <div className="flex-1 flex min-h-0">
              <div className="w-[38%] min-w-[280px] border-r border-border overflow-y-auto">
                {data.categories.length === 0 ? (
                  <div className="p-6 text-sm text-muted-foreground text-center">{t('contextInspector.empty')}</div>
                ) : data.categories.map((c, i) => (
                  <CategoryBlock
                    key={`${c.id}:${i}`}
                    category={c}
                    index={i}
                    color={colorOf(c.id)}
                    label={categoryLabel(c)}
                    expanded={expanded.has(i)}
                    selectedKey={expanded.has(i) ? selectedKey : null}
                    onToggle={toggle}
                    onSelect={select}
                  />
                ))}
              </div>
              <div className="flex-1 min-w-0 flex flex-col">
                {!selected ? (
                  <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground px-6 text-center">{t('contextInspector.selectItem')}</div>
                ) : (
                  <>
                    <div className="flex items-center gap-3 px-4 py-2 border-b border-border flex-shrink-0">
                      <span className="w-2.5 h-2.5 rounded-sm flex-shrink-0" style={{ backgroundColor: colorOf(selected.category.id) }} />
                      <div className="min-w-0 flex-1">
                        <div className="text-sm text-foreground font-mono truncate">{selected.item.label}</div>
                        <div className="text-[11px] text-muted-foreground truncate">
                          {categoryLabel(selected.category)}
                          {selected.item.path && ` · ${selected.item.path}`}
                          {selected.item.tokens !== null && ` · ${tokenLabel(selected.item.tokens, selected.item.exact ?? false)} tokens`}
                        </div>
                      </div>
                      {selected.item.content !== undefined && (
                        <button onClick={copy} className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground hover:bg-hover rounded transition-colors flex-shrink-0">
                          {copied ? t('contextInspector.copied') : t('contextInspector.copy')}
                        </button>
                      )}
                    </div>
                    {selected.item.truncated && (
                      <div className="px-4 py-1 text-[11px] text-amber-11 border-b border-border flex-shrink-0">
                        {t('contextInspector.truncated', { count: selected.item.content?.length ?? 0 })}
                      </div>
                    )}
                    <div className="flex-1 overflow-auto">
                      {selected.item.content === undefined ? (
                        <div className="p-6 text-sm text-muted-foreground">{t('contextInspector.noContent')}</div>
                      ) : (
                        <pre className="px-4 py-3 text-xs leading-relaxed font-mono text-foreground whitespace-pre-wrap break-words">{selected.item.content}</pre>
                      )}
                    </div>
                  </>
                )}
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
