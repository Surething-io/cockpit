'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Portal, usePanelPortalTarget } from '../shared/Portal';
import type { DeepseekModel } from './useTabState';

const MODELS: { value: DeepseekModel; label: string }[] = [
  { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
];

interface DeepseekConfigPickerProps {
  currentModel?: DeepseekModel;
  onModelChange: (model: DeepseekModel) => void;
}

/** Mask all but last 4 chars of an api key, e.g. sk-1234abcd → sk-•••••bcd */
function maskKey(key: string): string {
  if (!key) return '';
  if (key.length <= 8) return key.replace(/./g, '•');
  return `${key.slice(0, 3)}${'•'.repeat(Math.max(4, key.length - 7))}${key.slice(-4)}`;
}

export function DeepseekConfigPicker({ currentModel, onModelChange }: DeepseekConfigPickerProps) {
  const [open, setOpen] = useState(false);
  const [savedKey, setSavedKey] = useState<string>(''); // last persisted key
  const [keyInput, setKeyInput] = useState<string>(''); // editable buffer
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const panelTarget = usePanelPortalTarget();

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node) &&
          btnRef.current && !btnRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  // Load settings on first open
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch('/api/settings');
      if (!res.ok) {
        setError('Failed to load settings');
        return;
      }
      const data = await res.json();
      const key: string = data?.engines?.deepseek?.apiKey || '';
      setSavedKey(key);
      setKeyInput('');
      setEditing(false);
      // If parent didn't pass a model and settings has one, sync upward
      const savedModel: DeepseekModel | undefined = data?.engines?.deepseek?.model;
      if (!currentModel && savedModel && MODELS.some(m => m.value === savedModel)) {
        onModelChange(savedModel);
      }
    } catch {
      setError('Connection error');
    } finally {
      setLoading(false);
    }
  }, [currentModel, onModelChange]);

  const persistSettings = useCallback(async (patch: { apiKey?: string; model?: DeepseekModel }) => {
    // PUT /api/settings is a shallow merge — we only need to send the engines diff.
    const cur: Record<string, unknown> = await fetch('/api/settings')
      .then(r => r.ok ? r.json() : {})
      .catch(() => ({}));
    const curEngines = (cur.engines as Record<string, Record<string, unknown>> | undefined) || {};
    const engines = {
      ...curEngines,
      deepseek: { ...(curEngines.deepseek || {}), ...patch },
    };
    const res = await fetch('/api/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ engines }),
    });
    if (!res.ok) throw new Error('Failed to save settings');
  }, []);

  const toggle = () => {
    if (!open) {
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        const origin = panelTarget?.getBoundingClientRect();
        const ox = origin?.left ?? 0;
        const oy = origin?.top ?? 0;
        setPos({ top: rect.bottom + 4 - oy, left: rect.left - ox });
      }
      loadSettings();
    }
    setOpen(v => !v);
  };

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSaving(true);
    setError(null);
    try {
      await persistSettings({ apiKey: trimmed });
      setSavedKey(trimmed);
      setKeyInput('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Save failed');
    } finally {
      setSaving(false);
    }
  };

  const handleClearKey = async () => {
    setSaving(true);
    setError(null);
    try {
      await persistSettings({ apiKey: '' });
      setSavedKey('');
      setKeyInput('');
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Clear failed');
    } finally {
      setSaving(false);
    }
  };

  const handleSelectModel = async (model: DeepseekModel) => {
    onModelChange(model);
    try {
      await persistSettings({ model });
    } catch {
      // non-fatal — tab state already updated
    }
  };

  const beginEdit = () => {
    setEditing(true);
    setKeyInput('');
    // Defer focus until input is rendered
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const hasKey = !!savedKey;
  const displayLabel = !hasKey
    ? 'Set API key'
    : (currentModel || 'deepseek-v4-flash');
  const labelTone = !hasKey ? 'text-amber-400' : 'text-sky-400';

  const menu = open ? (
    <Portal>
      <div
        ref={menuRef}
        className="fixed z-[9999] bg-popover border border-border rounded-lg shadow-lg py-2 min-w-[280px]"
        style={{ top: pos.top, left: pos.left }}
      >
        {loading ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
            Loading...
          </div>
        ) : (
          <>
            {/* API Key section */}
            <div className="px-3 py-1.5">
              <div className="text-[11px] font-medium text-muted-foreground mb-1.5">API Key</div>
              {hasKey && !editing ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate text-xs px-2 py-1 rounded bg-secondary text-foreground font-mono">
                    {maskKey(savedKey)}
                  </code>
                  <button
                    onClick={beginEdit}
                    className="text-[11px] px-2 py-1 rounded bg-secondary hover:bg-accent text-foreground transition-colors"
                    disabled={saving}
                  >
                    Edit
                  </button>
                  <button
                    onClick={handleClearKey}
                    className="text-[11px] px-2 py-1 rounded text-red-400 hover:bg-red-500/10 transition-colors"
                    disabled={saving}
                  >
                    Clear
                  </button>
                </div>
              ) : (
                <div className="flex items-center gap-2">
                  <input
                    ref={inputRef}
                    type="password"
                    value={keyInput}
                    onChange={(e) => setKeyInput(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') handleSaveKey();
                    }}
                    placeholder="sk-..."
                    className="flex-1 min-w-0 text-xs px-2 py-1 rounded bg-secondary text-foreground border border-border focus:border-sky-500 focus:outline-none font-mono"
                    autoFocus
                  />
                  <button
                    onClick={handleSaveKey}
                    disabled={saving || !keyInput.trim()}
                    className="text-[11px] px-2 py-1 rounded bg-sky-500/20 hover:bg-sky-500/30 text-sky-300 transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
                  >
                    {saving ? 'Saving...' : 'Save'}
                  </button>
                  {hasKey && (
                    <button
                      onClick={() => { setEditing(false); setKeyInput(''); }}
                      className="text-[11px] px-2 py-1 rounded text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              )}
              {error && (
                <div className="mt-1 text-[11px] text-red-400">{error}</div>
              )}
            </div>

            <div className="my-1 border-t border-border" />

            {/* Model section */}
            <div className="px-3 py-1.5">
              <div className="text-[11px] font-medium text-muted-foreground mb-1.5">Model</div>
              <div className="flex flex-col gap-0.5">
                {MODELS.map((m) => {
                  const selected = (currentModel || 'deepseek-v4-flash') === m.value;
                  return (
                    <button
                      key={m.value}
                      onClick={() => handleSelectModel(m.value)}
                      className={`flex items-center gap-2 px-2 py-1 text-xs rounded transition-colors ${
                        selected ? 'bg-sky-500/15 text-sky-300' : 'text-foreground hover:bg-accent'
                      }`}
                    >
                      <span className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                        selected ? 'border-sky-400' : 'border-muted-foreground'
                      }`}>
                        {selected && <span className="w-1.5 h-1.5 rounded-full bg-sky-400" />}
                      </span>
                      <span>{m.label}</span>
                    </button>
                  );
                })}
              </div>
            </div>
          </>
        )}
      </div>
    </Portal>
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-sky-500/15 hover:bg-sky-500/25 transition-colors"
        title="Configure Deepseek"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-sky-500 flex-shrink-0" />
        <span className={`truncate max-w-[160px] ${labelTone}`}>{displayLabel}</span>
        <svg className="w-3 h-3 flex-shrink-0 text-sky-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {menu}
    </>
  );
}
