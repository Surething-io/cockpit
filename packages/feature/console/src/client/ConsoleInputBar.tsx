'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Zap, Variable, LayoutGrid, List, AppWindow } from 'lucide-react';
import { QuickCommandsPopover, useQuickCommands } from './QuickCommandsPopover';
import { matchInput } from './useConsoleState';
import type { CustomCommand } from '@/app/api/services/config/route';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { fetchAutocomplete } from './effect/consoleClient';

interface TaggedCommand extends CustomCommand {
  scope: 'project' | 'global';
}

/** A `/` autocomplete row: a registered HTML app, or a custom command. */
type SlashItem =
  | { kind: 'html'; name: string; path: string }
  | { kind: 'cmd'; cmd: TaggedCommand };

interface ConsoleInputBarProps {
  cwd: string;
  currentCwd: string;
  commandHistoryRef: React.RefObject<string[]>;
  gridLayout: boolean;
  onGridLayoutChange: (grid: boolean) => void;
  onExecute: (command: string) => void;
  onAddPluginItem?: (type: string, input: string) => void;
  onShowEnvManager: () => void;
  onOpenZsh: () => void;
  onOpenNote?: () => void;
}

export function ConsoleInputBar({
  cwd,
  currentCwd,
  commandHistoryRef,
  gridLayout,
  onGridLayoutChange,
  onExecute,
  onAddPluginItem,
  onShowEnvManager,
  onOpenZsh,
  onOpenNote,
}: ConsoleInputBarProps) {
  const { t } = useTranslation();
  const [inputValue, setInputValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState('');
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<string[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [htmlApps, setHtmlApps] = useState<{ name: string; path: string }[]>([]);
  const [slashItems, setSlashItems] = useState<SlashItem[]>([]);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  const { projectCommands, globalCommands, expandCustomCommand, loadQuickCommands } = useQuickCommands(cwd);

  // Focus input field
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // Registered HTML apps (name → path) for the `/name` autocomplete. Plain fetch
  // (no cross-package import); refreshed when the registry changes via the shared
  // BroadcastChannel (mirrors htmlAppsBus's channel name).
  useEffect(() => {
    let cancelled = false;
    const load = () => {
      fetch('/api/html-apps')
        .then(r => (r.ok ? r.json() : []))
        .then((list: Array<{ name?: string; path?: string; valid?: boolean }>) => {
          if (cancelled) return;
          setHtmlApps(
            (Array.isArray(list) ? list : [])
              .filter(a => a.valid !== false && a.name && a.path)
              .map(a => ({ name: a.name as string, path: a.path as string })),
          );
        })
        .catch(() => { /* registry optional */ });
    };
    load();
    let ch: BroadcastChannel | null = null;
    if (typeof BroadcastChannel !== 'undefined') {
      ch = new BroadcastChannel('cockpit-html-apps');
      ch.addEventListener('message', (e: MessageEvent) => { if (e.data?.type === 'changed') load(); });
    }
    return () => { cancelled = true; ch?.close(); };
  }, []);

  // Filter on input change: registered HTML apps first (open as bubble), then
  // custom commands (project-level before global).
  useEffect(() => {
    if (inputValue.startsWith('/')) {
      const keyword = inputValue.slice(1).toLowerCase();
      const htmlItems: SlashItem[] = htmlApps
        .filter(a => a.name.toLowerCase().startsWith(keyword))
        .map(a => ({ kind: 'html' as const, name: a.name, path: a.path }));
      // Guard on `name`: the API normalizes stored commands, but a stale
      // client bundle or a hand-edited config must not crash the React tree.
      const matches = (c: CustomCommand) =>
        typeof c?.name === 'string' && c.name.toLowerCase().startsWith(keyword);
      const cmdItems: SlashItem[] = [
        ...projectCommands.filter(matches).map(c => ({ ...c, scope: 'project' as const })),
        ...globalCommands.filter(matches).map(c => ({ ...c, scope: 'global' as const })),
      ].map(cmd => ({ kind: 'cmd' as const, cmd }));
      const items = [...htmlItems, ...cmdItems];
      queueMicrotask(() => {
        setSlashItems(items);
        setShowSlashCommands(items.length > 0);
        setSlashSelectedIndex(0);
      });
    } else {
      queueMicrotask(() => setShowSlashCommands(false));
    }
  }, [inputValue, projectCommands, globalCommands, htmlApps]);

  // Scroll selected item into view
  useEffect(() => {
    if (showSlashCommands && slashListRef.current) {
      const item = slashListRef.current.children[slashSelectedIndex] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [slashSelectedIndex, showSlashCommands]);

  const handleSlashSelect = useCallback((item: SlashItem) => {
    setShowSlashCommands(false);
    if (item.kind === 'html') {
      onAddPluginItem?.('browser', item.path);
      setInputValue('');
      return;
    }
    const finalCmd = item.cmd.command;
    const plugin = matchInput(finalCmd);
    if (plugin) {
      onAddPluginItem?.(plugin.type, finalCmd.trim());
    } else {
      onExecute(finalCmd);
    }
    setInputValue('');
  }, [onExecute, onAddPluginItem]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (isComposingRef.current) return;
    if (!inputValue.trim()) return;

    // `/name` that exactly matches a registered HTML app → open its bubble.
    // Otherwise fall through (never intercepts real commands like `/usr/bin/x`).
    if (inputValue.startsWith('/')) {
      const nm = inputValue.slice(1).trim();
      const hit = htmlApps.find(a => a.name === nm);
      if (hit) {
        onAddPluginItem?.('browser', hit.path);
        setInputValue('');
        setHistoryIndex(-1);
        setTemporaryInput('');
        setShowSlashCommands(false);
        return;
      }
    }

    const expanded = expandCustomCommand(inputValue);
    const finalInput = expanded ?? inputValue;

    const plugin = matchInput(finalInput);
    if (plugin) {
      onAddPluginItem?.(plugin.type, finalInput.trim());
    } else {
      onExecute(finalInput);
    }

    setInputValue('');
    setHistoryIndex(-1);
    setTemporaryInput('');
  }, [inputValue, onExecute, onAddPluginItem, expandCustomCommand, htmlApps]);

  const handleAutocomplete = useCallback(async () => {
    if (!inputRef.current) return;
    const cursorPosition = inputRef.current.selectionStart || 0;

    const exit = await BrowserRuntime.runPromiseExit(
      fetchAutocomplete({ cwd: currentCwd, input: inputValue, cursorPosition })
    );
    if (exit._tag === 'Success') {
      const data = exit.value;
      const suggestions = data.suggestions;
      if (suggestions && suggestions.length > 0) {
        setAutocompleteSuggestions(suggestions as string[]);
        setAutocompleteIndex(0);
        setShowAutocomplete(true);

        if (suggestions.length === 1) {
          const before = inputValue.substring(0, data.replaceStart ?? 0);
          const after = inputValue.substring(data.replaceEnd ?? cursorPosition);
          const newValue = before + suggestions[0] + after;
          setInputValue(newValue);
          setShowAutocomplete(false);

          setTimeout(() => {
            if (inputRef.current) {
              const newPos = (data.replaceStart ?? 0) + suggestions[0].length;
              inputRef.current.setSelectionRange(newPos, newPos);
            }
          }, 0);
        }
      }
    } else {
      console.error('Autocomplete error:', exit.cause);
    }
  }, [currentCwd, inputValue]);

  const applyAutocompleteSuggestion = useCallback((suggestion: string) => {
    if (!inputRef.current) return;
    const cursorPosition = inputRef.current.selectionStart || 0;
    const beforeCursor = inputValue.substring(0, cursorPosition);
    const afterCursor = inputValue.substring(cursorPosition);
    const words = beforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1] || '';
    const replaceStart = cursorPosition - lastWord.length;
    const before = inputValue.substring(0, replaceStart);
    const newValue = before + suggestion + afterCursor;
    setInputValue(newValue);
    setShowAutocomplete(false);

    setTimeout(() => {
      if (inputRef.current) {
        const newPos = replaceStart + suggestion.length;
        inputRef.current.setSelectionRange(newPos, newPos);
      }
    }, 0);
  }, [inputValue]);

  const handleKeyDown = useCallback((e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.nativeEvent.isComposing) return;

    // / candidate list keyboard navigation
    if (showSlashCommands && slashItems.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex(prev => (prev - 1 + slashItems.length) % slashItems.length);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex(prev => (prev + 1) % slashItems.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        handleSlashSelect(slashItems[slashSelectedIndex]);
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        setShowSlashCommands(false);
        return;
      }
    }

    if (e.key === 'Tab') {
      e.preventDefault();
      if (showAutocomplete && autocompleteSuggestions.length > 0) {
        const newIndex = (autocompleteIndex + 1) % autocompleteSuggestions.length;
        setAutocompleteIndex(newIndex);
        applyAutocompleteSuggestion(autocompleteSuggestions[newIndex]);
      } else {
        handleAutocomplete();
      }
      return;
    }

    if (e.key === 'Escape' && showAutocomplete) {
      e.preventDefault();
      setShowAutocomplete(false);
      return;
    }

    const history = commandHistoryRef.current;
    if (!history || history.length === 0) return;

    if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (historyIndex === -1) setTemporaryInput(inputValue);
      const newIndex = historyIndex === -1 ? history.length - 1 : Math.max(0, historyIndex - 1);
      setHistoryIndex(newIndex);
      setInputValue(history[newIndex]);
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      if (historyIndex === -1) return;
      const newIndex = historyIndex + 1;
      if (newIndex >= history.length) {
        setHistoryIndex(-1);
        setInputValue(temporaryInput);
      } else {
        setHistoryIndex(newIndex);
        setInputValue(history[newIndex]);
      }
    }
  }, [historyIndex, inputValue, temporaryInput, showAutocomplete, autocompleteSuggestions, autocompleteIndex, handleAutocomplete, applyAutocompleteSuggestion, showSlashCommands, slashItems, slashSelectedIndex, handleSlashSelect, commandHistoryRef]);

  return (
    <div className="border-t border-border p-4">
      <form onSubmit={handleSubmit} className="relative flex gap-2 items-center">
        {/* HTML apps launcher — opens the HtmlAppsModal (rendered in Workspace)
            via a window event, mirroring the sidebar's Skills button. */}
        <button
          type="button"
          onClick={() => window.dispatchEvent(new CustomEvent('cockpit-open-html-apps'))}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
          title={t('console.htmlApps')}
        >
          <AppWindow className="w-4 h-4" />
        </button>

        {/* Quick command button */}
        <div className="relative">
          <button
            type="button"
            onClick={() => {
              if (!showQuickCommands) loadQuickCommands();
              setShowQuickCommands(!showQuickCommands);
            }}
            className={`p-2 rounded-lg transition-all ${
              showQuickCommands
                ? 'text-brand bg-brand/10'
                : 'text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95'
            }`}
            title={t('console.quickCommands')}
          >
            <Zap className="w-4 h-4" />
          </button>

          <QuickCommandsPopover
            cwd={cwd}
            show={showQuickCommands}
            onClose={() => setShowQuickCommands(false)}
            onExecute={onExecute}
            onAddPluginItem={onAddPluginItem}
          />
        </div>

        {/* Project notes button */}
        {onOpenNote && (
          <button
            type="button"
            onClick={onOpenNote}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title={t('chat.projectNotes')}
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
            </svg>
          </button>
        )}

        <button
          type="button"
          onClick={() => onGridLayoutChange(!gridLayout)}
          className={`p-2 rounded-lg transition-all ${gridLayout ? 'text-brand bg-brand/10' : 'text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95'}`}
          title={gridLayout ? t('console.singleColumn') : t('console.dualColumn')}
        >
          {gridLayout ? <List className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={onShowEnvManager}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
          title={t('console.envVars')}
        >
          <Variable className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onOpenZsh}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
          title={t('console.launchZsh')}
        >
          <svg className="w-4 h-4" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
            <polyline points="4 17 10 11 4 5" />
            <line x1="12" y1="19" x2="20" y2="19" />
          </svg>
        </button>

        <input
          ref={inputRef}
          type="text"
          value={inputValue}
          onChange={(e) => {
            setInputValue(e.target.value);
            if (historyIndex !== -1) {
              setHistoryIndex(-1);
              setTemporaryInput('');
            }
            setShowAutocomplete(false);
          }}
          onKeyDown={handleKeyDown}
          onCompositionStart={() => { isComposingRef.current = true; }}
          onCompositionEnd={() => { isComposingRef.current = false; }}
          placeholder={t('console.inputPlaceholder')}
          className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono"
        />

        {/* / candidate list — HTML apps + custom commands */}
        {showSlashCommands && slashItems.length > 0 && (
          <div
            ref={slashListRef}
            className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto bg-popover border border-border rounded-lg shadow-lg z-50"
          >
            {slashItems.map((item, index) => (
              <div
                key={item.kind === 'html' ? `html-${item.name}` : `cmd-${item.cmd.scope}-${item.cmd.name}`}
                onClick={() => handleSlashSelect(item)}
                className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer text-sm ${
                  index === slashSelectedIndex ? 'bg-brand/10' : 'hover:bg-accent'
                }`}
              >
                {item.kind === 'html' ? (
                  <>
                    <span className="font-mono font-medium text-foreground">/{item.name}</span>
                    <span className="flex-1 text-muted-foreground truncate">{item.path}</span>
                    <span className="text-[10px] text-brand/70 flex-shrink-0">HTML</span>
                  </>
                ) : (
                  <>
                    <span className="font-mono font-medium text-foreground">/{item.cmd.name}</span>
                    <span className="flex-1 text-muted-foreground truncate">{item.cmd.command}</span>
                    <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">{item.cmd.scope === 'project' ? t('console.scopeProject') : t('console.scopeGlobal')}</span>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {showAutocomplete && autocompleteSuggestions.length > 1 && (
          <div className="absolute bottom-full left-0 mb-1 bg-popover border border-border rounded-lg shadow-lg max-h-48 overflow-y-auto z-50">
            <div className="py-1">
              {autocompleteSuggestions.map((suggestion, index) => (
                <button
                  key={index}
                  type="button"
                  onClick={() => applyAutocompleteSuggestion(suggestion)}
                  className={`w-full px-3 py-1.5 text-left text-sm font-mono hover:bg-accent transition-colors ${
                    index === autocompleteIndex ? 'bg-accent' : ''
                  }`}
                >
                  {suggestion}
                </button>
              ))}
            </div>
            <div className="border-t border-border px-3 py-1 text-xs text-muted-foreground">
              {t('console.tabSwitchEscClose')}
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
