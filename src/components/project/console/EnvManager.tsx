'use client';

import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { X, Plus, Trash2 } from 'lucide-react';

interface EnvManagerProps {
  cwd: string;
  tabId?: string;
  onClose: () => void;
  onSave: (env: Record<string, string>) => void;
}

export function EnvManager({ cwd, tabId, onClose, onSave }: EnvManagerProps) {
  const { t } = useTranslation();
  const [env, setEnv] = useState<Record<string, string>>({});
  const [newKey, setNewKey] = useState('');
  const [newValue, setNewValue] = useState('');
  const [isLoading, setIsLoading] = useState(true);

  // Load environment variables
  useEffect(() => {
    loadEnv();
  }, [cwd, tabId]);

  const loadEnv = async () => {
    setIsLoading(true);
    try {
      const params = new URLSearchParams({ cwd });
      if (tabId) params.set('tabId', tabId);

      const response = await fetch(`/api/terminal/env?${params}`);
      if (response.ok) {
        const data = await response.json();
        setEnv(data.env || {});
      }
    } catch (error) {
      console.error('Failed to load env:', error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleAdd = () => {
    if (!newKey.trim()) return;

    setEnv((prev) => ({
      ...prev,
      [newKey.trim()]: newValue,
    }));
    setNewKey('');
    setNewValue('');
  };

  const handleDelete = (key: string) => {
    setEnv((prev) => {
      const updated = { ...prev };
      delete updated[key];
      return updated;
    });
  };

  const handleUpdate = (key: string, value: string) => {
    setEnv((prev) => ({
      ...prev,
      [key]: value,
    }));
  };

  const handleSave = async () => {
    try {
      const response = await fetch('/api/terminal/env', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd, tabId, env }),
      });

      if (response.ok) {
        onSave(env);
        onClose();
      }
    } catch (error) {
      console.error('Failed to save env:', error);
    }
  };

  return (
    <div className="absolute inset-0 bg-black/50 flex items-center justify-center z-50">
      <div className="bg-background border border-border rounded-lg shadow-xl w-full max-w-2xl max-h-[80vh] flex flex-col m-4">
        {/* Title bar */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div>
            <h2 className="text-lg font-semibold">{t('envManager.title')}</h2>
            <p className="text-xs text-muted-foreground mt-0.5">
              {tabId ? t('envManager.tabScope') : t('envManager.globalScope')}
            </p>
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Content area */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              {t('common.loading')}
            </div>
          ) : (
            <div className="space-y-3">
              {/* Existing environment variables */}
              {Object.entries(env).map(([key, value]) => (
                <div key={key} className="flex items-start gap-2">
                  <input
                    type="text"
                    value={key}
                    disabled
                    className="flex-1 px-3 py-2 rounded-lg border border-input bg-muted text-sm font-mono"
                  />
                  <input
                    type="text"
                    value={value}
                    onChange={(e) => handleUpdate(key, e.target.value)}
                    placeholder={t('envManager.valuePlaceholder')}
                    className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                  />
                  <button
                    onClick={() => handleDelete(key)}
                    className="p-2 rounded-lg text-destructive hover:bg-destructive/10 transition-colors"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}

              {/* Add new variable */}
              <div className="flex items-start gap-2 pt-2 border-t border-border">
                <input
                  type="text"
                  value={newKey}
                  onChange={(e) => setNewKey(e.target.value)}
                  placeholder={t('envManager.varNamePlaceholder')}
                  className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleAdd();
                    }
                  }}
                />
                <input
                  type="text"
                  value={newValue}
                  onChange={(e) => setNewValue(e.target.value)}
                  placeholder={t('envManager.varValuePlaceholder')}
                  className="flex-1 px-3 py-2 rounded-lg border border-input bg-background text-sm font-mono focus:outline-none focus:ring-2 focus:ring-brand focus:border-transparent"
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      handleAdd();
                    }
                  }}
                />
                <button
                  onClick={handleAdd}
                  disabled={!newKey.trim()}
                  className="p-2 rounded-lg bg-brand text-brand-foreground hover:bg-brand/90 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  <Plus className="w-4 h-4" />
                </button>
              </div>

              {Object.keys(env).length === 0 && (
                <div className="text-center py-8 text-muted-foreground text-sm">
                  {t('envManager.noVars')}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Bottom action bar */}
        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-border">
          <button
            onClick={onClose}
            className="px-4 py-2 rounded-lg text-sm hover:bg-accent transition-colors"
          >
            {t('common.cancel')}
          </button>
          <button
            onClick={handleSave}
            className="px-4 py-2 rounded-lg text-sm bg-brand text-brand-foreground hover:bg-brand/90 transition-colors"
          >
            {t('common.save')}
          </button>
        </div>
      </div>
    </div>
  );
}
