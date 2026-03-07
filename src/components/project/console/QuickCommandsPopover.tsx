'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, X, Play } from 'lucide-react';
import { Tooltip } from '@/components/shared/Tooltip';
import type { CustomCommand } from '@/app/api/services/config/route';
import { isUrlInput } from '@/hooks/useConsoleState';

interface QuickCommandsPopoverProps {
  cwd: string;
  show: boolean;
  onClose: () => void;
  onExecute: (command: string) => void;
  onAddBrowser: (url: string) => void;
}

export function QuickCommandsPopover({ cwd, show, onClose, onExecute, onAddBrowser }: QuickCommandsPopoverProps) {
  const [customCommands, setCustomCommands] = useState<CustomCommand[]>([]);
  const [scripts, setScripts] = useState<Record<string, string>>({});
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const ref = useRef<HTMLDivElement>(null);

  const loadQuickCommands = useCallback(async () => {
    try {
      const [configRes, scriptsRes] = await Promise.all([
        fetch(`/api/services/config?cwd=${encodeURIComponent(cwd)}`),
        fetch(`/api/services/scripts?cwd=${encodeURIComponent(cwd)}`),
      ]);
      if (configRes.ok) {
        const data = await configRes.json();
        setCustomCommands(data.customCommands || []);
      }
      if (scriptsRes.ok) {
        const data = await scriptsRes.json();
        setScripts(data.scripts || {});
      }
    } catch (error) {
      console.error('Failed to load quick commands:', error);
    }
  }, [cwd]);

  // 打开时加载
  useEffect(() => {
    if (show) loadQuickCommands();
  }, [show, loadQuickCommands]);

  // 点击外部关闭
  useEffect(() => {
    if (!show) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
        setIsAdding(false);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [show, onClose]);

  const saveCustomCommands = useCallback(async (commands: CustomCommand[]) => {
    setCustomCommands(commands);
    try {
      await fetch('/api/services/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, customCommands: commands }),
      });
    } catch (error) {
      console.error('Failed to save custom commands:', error);
    }
  }, [cwd]);

  const handleQuickCommand = useCallback((command: string) => {
    onClose();
    if (isUrlInput(command)) {
      onAddBrowser(command.trim());
    } else {
      onExecute(command);
    }
  }, [onClose, onExecute, onAddBrowser]);

  if (!show) return null;

  return (
    <div ref={ref} className="absolute bottom-full left-0 mb-2 w-72 bg-popover border border-border rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto">
      <div className="p-2">
        <div className="flex items-center justify-between mb-1">
          <span className="text-xs font-medium text-muted-foreground px-1">自定义命令</span>
          <button
            type="button"
            onClick={() => { setIsAdding(true); setNewName(''); setNewCommand(''); }}
            className="p-0.5 text-muted-foreground hover:text-foreground rounded"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>
        {isAdding && (
          <div className="flex gap-1 mb-1">
            <input
              type="text"
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="名称"
              className="w-24 flex-shrink-0 px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              autoFocus
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setIsAdding(false); }
              }}
            />
            <input
              type="text"
              value={newCommand}
              onChange={(e) => setNewCommand(e.target.value)}
              placeholder="命令"
              className="flex-1 min-w-0 px-2 py-1 text-xs font-mono rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  e.stopPropagation();
                  if (newName.trim() && newCommand.trim()) {
                    saveCustomCommands([...customCommands, { name: newName.trim(), command: newCommand.trim() }]);
                    setNewName('');
                    setNewCommand('');
                    setIsAdding(false);
                  }
                } else if (e.key === 'Escape') {
                  setIsAdding(false);
                }
              }}
            />
          </div>
        )}
        {customCommands.length === 0 && !isAdding && (
          <div className="text-xs text-muted-foreground px-1 py-1">暂无自定义命令</div>
        )}
        {customCommands.map((cmd, i) => (
          <Tooltip key={i} content={cmd.command}>
            <div className="flex items-center group min-w-0">
              <button
                type="button"
                onClick={() => handleQuickCommand(cmd.command)}
                className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-accent transition-colors"
              >
                <Play className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
                <span className="truncate">{cmd.name}</span>
              </button>
              <button
                type="button"
                onClick={() => saveCustomCommands(customCommands.filter((_, j) => j !== i))}
                className="p-1 text-muted-foreground hover:text-destructive rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
              >
                <X className="w-3 h-3" />
              </button>
            </div>
          </Tooltip>
        ))}
      </div>
    </div>
  );
}

// Re-export for ConsoleInputBar slash command expansion
export function useQuickCommands(cwd: string) {
  const [quickCustomCommands, setQuickCustomCommands] = useState<CustomCommand[]>([]);

  const loadQuickCommands = useCallback(async () => {
    try {
      const res = await fetch(`/api/services/config?cwd=${encodeURIComponent(cwd)}`);
      if (res.ok) {
        const data = await res.json();
        setQuickCustomCommands(data.customCommands || []);
      }
    } catch { /* ignore */ }
  }, [cwd]);

  useEffect(() => {
    loadQuickCommands();
  }, [loadQuickCommands]);

  const expandCustomCommand = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const firstWord = parts[0];
    if (!firstWord.startsWith('/') || firstWord.length <= 1) return null;
    const cmdName = firstWord.slice(1);
    const matched = quickCustomCommands.find(c => c.name === cmdName);
    if (!matched) return null;
    return matched.command + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
  }, [quickCustomCommands]);

  return { quickCustomCommands, expandCustomCommand, loadQuickCommands };
}
