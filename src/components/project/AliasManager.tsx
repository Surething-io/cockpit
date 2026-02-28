'use client';

import { useState, useEffect } from 'react';
import { X, Plus, Trash2, Terminal } from 'lucide-react';

interface AliasManagerProps {
  onClose: () => void;
  onSave: (aliases: Record<string, string>) => void;
}

export function AliasManager({ onClose, onSave }: AliasManagerProps) {
  const [aliases, setAliases] = useState<Record<string, string>>({});
  const [newAlias, setNewAlias] = useState('');
  const [newCommand, setNewCommand] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // 加载全局别名
  useEffect(() => {
    loadAliases();
  }, []);

  const loadAliases = async () => {
    setIsLoading(true);
    try {
      const response = await fetch('/api/terminal/aliases');
      if (response.ok) {
        const data = await response.json();
        setAliases(data.aliases || {});
      }
    } catch (error) {
      console.error('Failed to load aliases:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAdd = () => {
    if (!newAlias.trim() || !newCommand.trim()) return;

    setAliases((prev) => ({
      ...prev,
      [newAlias.trim()]: newCommand.trim(),
    }));
    setNewAlias('');
    setNewCommand('');
  };

  const handleDelete = (alias: string) => {
    setAliases((prev) => {
      const updated = { ...prev };
      delete updated[alias];
      return updated;
    });
  };

  const handleUpdate = (alias: string, command: string) => {
    setAliases((prev) => ({
      ...prev,
      [alias]: command,
    }));
  };

  const handleSave = async () => {
    try {
      const response = await fetch('/api/terminal/aliases', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ aliases }),
      });

      if (response.ok) {
        onSave(aliases);
        onClose();
      }
    } catch (error) {
      console.error('Failed to save aliases:', error);
    }
  };

  return (
    <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col m-4">
        {/* 标题栏 */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold flex items-center gap-2">
              <Terminal className="w-5 h-5" />
              命令别名管理
            </h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              为常用命令设置快捷别名（全局生效）
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容区域 */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              加载中...
            </div>
          ) : (
            <div className="space-y-3">
              {/* 现有别名 */}
              {Object.entries(aliases).map(([alias, command]) => (
                <div key={alias} className="flex items-start gap-2 group">
                  <div className="flex-1 grid grid-cols-2 gap-2">
                    <div className="relative">
                      <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                        $
                      </div>
                      <input
                        type="text"
                        value={alias}
                        disabled
                        className="w-full pl-7 pr-3 py-2 rounded-lg border border-input bg-muted text-sm font-mono"
                      />
                    </div>
                    <input
                      type="text"
                      value={command}
                      onChange={(e) => handleUpdate(alias, e.target.value)}
                      placeholder="完整命令"
                      className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                    />
                  </div>
                  <button
                    onClick={() => handleDelete(alias)}
                    className="p-2 rounded-lg text-destructive hover:bg-destructive/10 transition-colors opacity-0 group-hover:opacity-100"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}

              {/* 添加新别名 */}
              <div className="flex items-start gap-2 pt-2 border-t border-border">
                <div className="flex-1 grid grid-cols-2 gap-2">
                  <div className="relative">
                    <div className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground text-sm">
                      $
                    </div>
                    <input
                      type="text"
                      value={newAlias}
                      onChange={(e) => setNewAlias(e.target.value)}
                      placeholder="别名（如 ll）"
                      className="w-full pl-7 pr-3 py-2 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                          e.preventDefault();
                          handleAdd();
                        }
                      }}
                    />
                  </div>
                  <input
                    type="text"
                    value={newCommand}
                    onChange={(e) => setNewCommand(e.target.value)}
                    placeholder="完整命令（如 ls -la）"
                    className="w-full px-3 py-2 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleAdd();
                      }
                    }}
                  />
                </div>
                <button
                  onClick={handleAdd}
                  disabled={!newAlias.trim() || !newCommand.trim()}
                  className="p-2 rounded-lg bg-brand text-brand-foreground hover:bg-brand/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {/* 提示信息 */}
              <div className="mt-4 p-3 bg-accent rounded-lg">
                <p className="text-sm text-muted-foreground">
                  💡 <strong>使用提示：</strong>输入别名即可执行对应的完整命令
                </p>
                <div className="mt-2 space-y-1 text-xs text-muted-foreground">
                  <div className="flex items-center gap-2">
                    <code className="px-1.5 py-0.5 bg-background rounded">$ ll</code>
                    <span>→</span>
                    <code className="px-1.5 py-0.5 bg-background rounded">ls -la</code>
                  </div>
                  <div className="flex items-center gap-2">
                    <code className="px-1.5 py-0.5 bg-background rounded">$ gs</code>
                    <span>→</span>
                    <code className="px-1.5 py-0.5 bg-background rounded">git status</code>
                  </div>
                </div>
              </div>

              {Object.keys(aliases).length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  还没有命令别名，添加一个试试
                </div>
              )}
            </div>
          )}
        </div>

        {/* 底部操作栏 */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm hover:bg-accent transition-colors"
          >
            取消
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm bg-brand text-brand-foreground hover:bg-brand/90 transition-colors"
          >
            保存
          </button>
        </div>
      </div>
    </div>
  );
}
