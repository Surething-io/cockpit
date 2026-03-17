'use client';

import { useState, useRef, useEffect, useCallback } from 'react';
import { Zap, Variable, LayoutGrid, List } from 'lucide-react';
import { QuickCommandsPopover, useQuickCommands } from './QuickCommandsPopover';
import { isUrlInput, isPostgresInput } from '@/hooks/useConsoleState';
import type { CustomCommand } from '@/app/api/services/config/route';

interface TaggedCommand extends CustomCommand {
  scope: 'project' | 'global';
}

interface ConsoleInputBarProps {
  cwd: string;
  currentCwd: string;
  commandHistoryRef: React.RefObject<string[]>;
  gridLayout: boolean;
  onGridLayoutChange: (grid: boolean) => void;
  onExecute: (command: string) => void;
  onAddBrowser: (url: string) => void;
  onAddDatabase?: (connStr: string) => void;
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
  onAddBrowser,
  onAddDatabase,
  onShowEnvManager,
  onOpenZsh,
  onOpenNote,
}: ConsoleInputBarProps) {
  const [inputValue, setInputValue] = useState('');
  const [historyIndex, setHistoryIndex] = useState(-1);
  const [temporaryInput, setTemporaryInput] = useState('');
  const [autocompleteSuggestions, setAutocompleteSuggestions] = useState<string[]>([]);
  const [autocompleteIndex, setAutocompleteIndex] = useState(0);
  const [showAutocomplete, setShowAutocomplete] = useState(false);
  const [showQuickCommands, setShowQuickCommands] = useState(false);
  const [filteredSlashCommands, setFilteredSlashCommands] = useState<TaggedCommand[]>([]);
  const [showSlashCommands, setShowSlashCommands] = useState(false);
  const [slashSelectedIndex, setSlashSelectedIndex] = useState(0);

  const inputRef = useRef<HTMLInputElement>(null);
  const slashListRef = useRef<HTMLDivElement>(null);
  const isComposingRef = useRef(false);

  const { projectCommands, globalCommands, expandCustomCommand, loadQuickCommands } = useQuickCommands(cwd);

  // 聚焦输入框
  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // 输入变化时过滤 / 自定义命令（项目级在前，全局在后）
  useEffect(() => {
    if (inputValue.startsWith('/')) {
      const keyword = inputValue.slice(1).toLowerCase();
      const taggedProject: TaggedCommand[] = projectCommands
        .filter(c => c.name.toLowerCase().startsWith(keyword))
        .map(c => ({ ...c, scope: 'project' as const }));
      const taggedGlobal: TaggedCommand[] = globalCommands
        .filter(c => c.name.toLowerCase().startsWith(keyword))
        .map(c => ({ ...c, scope: 'global' as const }));
      const filtered = [...taggedProject, ...taggedGlobal];
      setFilteredSlashCommands(filtered);
      setShowSlashCommands(filtered.length > 0);
      setSlashSelectedIndex(0);
    } else {
      setShowSlashCommands(false);
    }
  }, [inputValue, projectCommands, globalCommands]);

  // 滚动选中项到可视区域
  useEffect(() => {
    if (showSlashCommands && slashListRef.current) {
      const item = slashListRef.current.children[slashSelectedIndex] as HTMLElement;
      item?.scrollIntoView({ block: 'nearest' });
    }
  }, [slashSelectedIndex, showSlashCommands]);

  const handleSlashSelect = useCallback((cmd: CustomCommand) => {
    setShowSlashCommands(false);
    const finalCmd = cmd.command;
    if (isPostgresInput(finalCmd)) {
      onAddDatabase?.(finalCmd.trim());
    } else if (isUrlInput(finalCmd)) {
      onAddBrowser(finalCmd.trim());
    } else {
      onExecute(finalCmd);
    }
    setInputValue('');
  }, [onExecute, onAddBrowser, onAddDatabase]);

  const handleSubmit = useCallback((e: React.FormEvent) => {
    e.preventDefault();
    if (isComposingRef.current) return;
    if (!inputValue.trim()) return;

    const expanded = expandCustomCommand(inputValue);
    const finalInput = expanded ?? inputValue;

    if (isPostgresInput(finalInput)) {
      onAddDatabase?.(finalInput.trim());
    } else if (isUrlInput(finalInput)) {
      onAddBrowser(finalInput.trim());
    } else {
      onExecute(finalInput);
    }

    setInputValue('');
    setHistoryIndex(-1);
    setTemporaryInput('');
  }, [inputValue, onExecute, onAddBrowser, onAddDatabase, expandCustomCommand]);

  const handleAutocomplete = useCallback(async () => {
    if (!inputRef.current) return;
    const cursorPosition = inputRef.current.selectionStart || 0;

    try {
      const response = await fetch('/api/terminal/autocomplete', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: currentCwd, input: inputValue, cursorPosition }),
      });

      if (response.ok) {
        const data = await response.json();
        if (data.suggestions && data.suggestions.length > 0) {
          setAutocompleteSuggestions(data.suggestions);
          setAutocompleteIndex(0);
          setShowAutocomplete(true);

          if (data.suggestions.length === 1) {
            const before = inputValue.substring(0, data.replaceStart);
            const after = inputValue.substring(data.replaceEnd);
            const newValue = before + data.suggestions[0] + after;
            setInputValue(newValue);
            setShowAutocomplete(false);

            setTimeout(() => {
              if (inputRef.current) {
                const newPos = data.replaceStart + data.suggestions[0].length;
                inputRef.current.setSelectionRange(newPos, newPos);
              }
            }, 0);
          }
        }
      }
    } catch (error) {
      console.error('Autocomplete error:', error);
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

    // / 命令候选列表键盘导航
    if (showSlashCommands && filteredSlashCommands.length > 0) {
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSlashSelectedIndex(prev => (prev - 1 + filteredSlashCommands.length) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSlashSelectedIndex(prev => (prev + 1) % filteredSlashCommands.length);
        return;
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault();
        handleSlashSelect(filteredSlashCommands[slashSelectedIndex]);
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
  }, [historyIndex, inputValue, temporaryInput, showAutocomplete, autocompleteSuggestions, autocompleteIndex, handleAutocomplete, applyAutocompleteSuggestion, showSlashCommands, filteredSlashCommands, slashSelectedIndex, handleSlashSelect, commandHistoryRef]);

  return (
    <div className="border-t border-border p-4">
      <form onSubmit={handleSubmit} className="relative flex gap-2 items-center">
        {/* 快捷命令按钮 */}
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
            title="快捷命令"
          >
            <Zap className="w-4 h-4" />
          </button>

          <QuickCommandsPopover
            cwd={cwd}
            show={showQuickCommands}
            onClose={() => setShowQuickCommands(false)}
            onExecute={onExecute}
            onAddBrowser={onAddBrowser}
          />
        </div>

        {/* 项目笔记按钮 */}
        {onOpenNote && (
          <button
            type="button"
            onClick={onOpenNote}
            className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
            title="项目笔记"
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
          title={gridLayout ? '单列布局' : '双列布局'}
        >
          {gridLayout ? <List className="w-4 h-4" /> : <LayoutGrid className="w-4 h-4" />}
        </button>
        <button
          type="button"
          onClick={onShowEnvManager}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
          title="环境变量"
        >
          <Variable className="w-4 h-4" />
        </button>

        <button
          type="button"
          onClick={onOpenZsh}
          className="p-2 text-muted-foreground hover:text-foreground hover:bg-accent active:bg-muted active:scale-95 rounded-lg transition-all"
          title="启动 zsh 交互终端"
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
          placeholder="输入命令或网址并按 Enter... (↑↓ 历史, Tab 补全)"
          className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm focus:outline-none focus:ring-2 focus:ring-ring font-mono"
        />

        {/* / 自定义命令候选列表 */}
        {showSlashCommands && filteredSlashCommands.length > 0 && (
          <div
            ref={slashListRef}
            className="absolute bottom-full left-0 right-0 mb-1 max-h-64 overflow-y-auto bg-popover border border-border rounded-lg shadow-lg z-50"
          >
            {filteredSlashCommands.map((cmd, index) => (
              <div
                key={`${cmd.scope}-${cmd.name}`}
                onClick={() => handleSlashSelect(cmd)}
                className={`flex items-center gap-3 px-3 py-1.5 cursor-pointer text-sm ${
                  index === slashSelectedIndex ? 'bg-brand/10' : 'hover:bg-accent'
                }`}
              >
                <span className="font-mono font-medium text-foreground">/{cmd.name}</span>
                <span className="flex-1 text-muted-foreground truncate">{cmd.command}</span>
                <span className="text-[10px] text-muted-foreground/60 flex-shrink-0">{cmd.scope === 'project' ? '项目' : '全局'}</span>
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
              Tab 切换 · Esc 关闭
            </div>
          </div>
        )}
      </form>
    </div>
  );
}
