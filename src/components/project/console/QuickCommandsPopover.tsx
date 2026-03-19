'use client';

import { useState, useEffect, useRef, useCallback } from 'react';
import { Plus, X, Play } from 'lucide-react';
import { Tooltip } from '@/components/shared/Tooltip';
import type { CustomCommand } from '@/app/api/services/config/route';
import { matchInput } from '@/hooks/useConsoleState';

interface QuickCommandsPopoverProps {
  cwd: string;
  show: boolean;
  onClose: () => void;
  onExecute: (command: string) => void;
  onAddPluginItem?: (type: string, input: string) => void;
}

/** Inline add-command row */
function AddCommandRow({ onAdd, onCancel }: { onAdd: (name: string, command: string) => void; onCancel: () => void }) {
  const [name, setName] = useState('');
  const [command, setCommand] = useState('');

  return (
    <div className="flex gap-1 mb-1">
      <input
        type="text"
        value={name}
        onChange={(e) => setName(e.target.value)}
        placeholder="名称"
        className="w-24 flex-shrink-0 px-2 py-1 text-xs rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        autoFocus
        onKeyDown={(e) => {
          if (e.key === 'Escape') onCancel();
        }}
      />
      <input
        type="text"
        value={command}
        onChange={(e) => setCommand(e.target.value)}
        placeholder="命令"
        className="flex-1 min-w-0 px-2 py-1 text-xs font-mono rounded border border-input bg-background focus:outline-none focus:ring-1 focus:ring-ring"
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
            e.preventDefault();
            e.stopPropagation();
            if (name.trim() && command.trim()) {
              onAdd(name.trim(), command.trim());
            }
          } else if (e.key === 'Escape') {
            onCancel();
          }
        }}
      />
    </div>
  );
}

/** Command list section (reused for global / project) */
function CommandSection({
  label,
  commands,
  isAdding,
  onStartAdd,
  onAdd,
  onCancelAdd,
  onDelete,
  onExecute,
}: {
  label: string;
  commands: CustomCommand[];
  isAdding: boolean;
  onStartAdd: () => void;
  onAdd: (name: string, command: string) => void;
  onCancelAdd: () => void;
  onDelete: (index: number) => void;
  onExecute: (command: string) => void;
}) {
  return (
    <div className="p-2">
      <div className="flex items-center justify-between mb-1">
        <span className="text-xs font-medium text-muted-foreground px-1">{label}</span>
        <button
          type="button"
          onClick={onStartAdd}
          className="p-0.5 text-muted-foreground hover:text-foreground rounded"
        >
          <Plus className="w-3.5 h-3.5" />
        </button>
      </div>
      {isAdding && (
        <AddCommandRow
          onAdd={(name, command) => onAdd(name, command)}
          onCancel={onCancelAdd}
        />
      )}
      {commands.length === 0 && !isAdding && (
        <div className="text-xs text-muted-foreground px-1 py-1">暂无自定义命令</div>
      )}
      {commands.map((cmd, i) => (
        <Tooltip key={i} content={cmd.command}>
          <div className="flex items-center group min-w-0">
            <button
              type="button"
              onClick={() => onExecute(cmd.command)}
              className="flex-1 min-w-0 flex items-center gap-2 px-2 py-1.5 text-left text-sm rounded hover:bg-accent transition-colors"
            >
              <Play className="w-3 h-3 flex-shrink-0 text-muted-foreground" />
              <span className="truncate">{cmd.name}</span>
            </button>
            <button
              type="button"
              onClick={() => onDelete(i)}
              className="p-1 text-muted-foreground hover:text-destructive rounded opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0"
            >
              <X className="w-3 h-3" />
            </button>
          </div>
        </Tooltip>
      ))}
    </div>
  );
}

export function QuickCommandsPopover({ cwd, show, onClose, onExecute, onAddPluginItem }: QuickCommandsPopoverProps) {
  const [globalCommands, setGlobalCommands] = useState<CustomCommand[]>([]);
  const [projectCommands, setProjectCommands] = useState<CustomCommand[]>([]);
  const [addingSection, setAddingSection] = useState<'global' | 'project' | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const loadCommands = useCallback(async () => {
    try {
      const [globalRes, projectRes] = await Promise.all([
        fetch('/api/services/config?scope=global'),
        fetch(`/api/services/config?cwd=${encodeURIComponent(cwd)}`),
      ]);
      if (globalRes.ok) {
        const data = await globalRes.json();
        setGlobalCommands(data.customCommands || []);
      }
      if (projectRes.ok) {
        const data = await projectRes.json();
        setProjectCommands(data.customCommands || []);
      }
    } catch (error) {
      console.error('Failed to load commands:', error);
    }
  }, [cwd]);

  // 打开时加载
  useEffect(() => {
    if (show) loadCommands();
  }, [show, loadCommands]);

  // 点击外部关闭
  useEffect(() => {
    if (!show) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        onClose();
        setAddingSection(null);
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [show, onClose]);

  const saveGlobalCommands = useCallback(async (commands: CustomCommand[]) => {
    setGlobalCommands(commands);
    try {
      await fetch('/api/services/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ scope: 'global', customCommands: commands }),
      });
    } catch (error) {
      console.error('Failed to save global commands:', error);
    }
  }, []);

  const saveProjectCommands = useCallback(async (commands: CustomCommand[]) => {
    setProjectCommands(commands);
    try {
      await fetch('/api/services/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, customCommands: commands }),
      });
    } catch (error) {
      console.error('Failed to save project commands:', error);
    }
  }, [cwd]);

  const handleExecute = useCallback((command: string) => {
    onClose();
    const plugin = matchInput(command);
    if (plugin) {
      onAddPluginItem?.(plugin.type, command.trim());
    } else {
      onExecute(command);
    }
  }, [onClose, onExecute, onAddPluginItem]);

  if (!show) return null;

  return (
    <div ref={ref} className="absolute bottom-full left-0 mb-2 w-72 bg-popover border border-border rounded-lg shadow-lg z-50 max-h-[70vh] overflow-y-auto">
      <CommandSection
        label="全局命令"
        commands={globalCommands}
        isAdding={addingSection === 'global'}
        onStartAdd={() => setAddingSection('global')}
        onAdd={(name, command) => {
          saveGlobalCommands([...globalCommands, { name, command }]);
          setAddingSection(null);
        }}
        onCancelAdd={() => setAddingSection(null)}
        onDelete={(i) => saveGlobalCommands(globalCommands.filter((_, j) => j !== i))}
        onExecute={handleExecute}
      />
      <div className="border-t border-border" />
      <CommandSection
        label="项目命令"
        commands={projectCommands}
        isAdding={addingSection === 'project'}
        onStartAdd={() => setAddingSection('project')}
        onAdd={(name, command) => {
          saveProjectCommands([...projectCommands, { name, command }]);
          setAddingSection(null);
        }}
        onCancelAdd={() => setAddingSection(null)}
        onDelete={(i) => saveProjectCommands(projectCommands.filter((_, j) => j !== i))}
        onExecute={handleExecute}
      />
    </div>
  );
}

// Re-export for ConsoleInputBar slash command expansion
export function useQuickCommands(cwd: string) {
  const [projectCommands, setProjectCommands] = useState<CustomCommand[]>([]);
  const [globalCommands, setGlobalCommands] = useState<CustomCommand[]>([]);

  const loadQuickCommands = useCallback(async () => {
    try {
      const [projectRes, globalRes] = await Promise.all([
        fetch(`/api/services/config?cwd=${encodeURIComponent(cwd)}`),
        fetch('/api/services/config?scope=global'),
      ]);
      if (projectRes.ok) {
        const data = await projectRes.json();
        setProjectCommands(data.customCommands || []);
      }
      if (globalRes.ok) {
        const data = await globalRes.json();
        setGlobalCommands(data.customCommands || []);
      }
    } catch { /* ignore */ }
  }, [cwd]);

  useEffect(() => {
    loadQuickCommands();
  }, [loadQuickCommands]);

  // Combined list: project first, then global
  const quickCustomCommands = [...projectCommands, ...globalCommands];

  const expandCustomCommand = useCallback((input: string): string | null => {
    const trimmed = input.trim();
    const parts = trimmed.split(/\s+/);
    const firstWord = parts[0];
    if (!firstWord.startsWith('/') || firstWord.length <= 1) return null;
    const cmdName = firstWord.slice(1);
    // Project commands take priority over global
    const matched = projectCommands.find(c => c.name === cmdName)
      ?? globalCommands.find(c => c.name === cmdName);
    if (!matched) return null;
    return matched.command + (parts.length > 1 ? ' ' + parts.slice(1).join(' ') : '');
  }, [projectCommands, globalCommands]);

  return { quickCustomCommands, projectCommands, globalCommands, expandCustomCommand, loadQuickCommands };
}
