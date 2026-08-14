'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  ENGINE_MENU_CLASS,
  ENGINE_MENU_INPUT_FOCUS,
  ENGINE_MENU_ROW_SELECTED,
  ENGINE_MENU_SAVE,
  EngineCheck,
  EngineIcon,
  EnginePickerTrigger,
} from './engineAccents';
import {
  loadOllamaModelsWithAutoStart,
  loadOllamaConfig,
  saveOllamaConfig,
  type OllamaConfigInfo,
} from './effect/agentClient';

interface OllamaModel {
  name: string;
  size: number;
  modified_at: string;
  family?: string;
  parameter_size?: string;
}

interface OllamaModelPickerProps {
  currentModel?: string;
  onModelChange: (model: string) => void;
}

/** Format bytes to human-readable size */
function formatSize(bytes: number): string {
  if (bytes < 1e9) return `${(bytes / 1e6).toFixed(0)}M`;
  return `${(bytes / 1e9).toFixed(1)}G`;
}

/** Human hint for where a resolved value came from (only shown when not from the config file). */
function sourceHint(source: OllamaConfigInfo['baseUrlSource']): string | null {
  if (source === 'env') return 'from env var';
  if (source === 'default') return 'default';
  return null;
}

export function OllamaModelPicker({ currentModel, onModelChange }: OllamaModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  // Connection config (baseUrl + apiKey) — resolved effective values.
  const [configLoading, setConfigLoading] = useState(false);
  const [savingConfig, setSavingConfig] = useState(false);
  const [configError, setConfigError] = useState<string | null>(null);
  const [baseUrlInput, setBaseUrlInput] = useState('');
  const [baseUrlSource, setBaseUrlSource] = useState<OllamaConfigInfo['baseUrlSource']>('default');
  const [hasKey, setHasKey] = useState(false);
  const [maskedKey, setMaskedKey] = useState('');
  const [keySource, setKeySource] = useState<OllamaConfigInfo['keySource']>('default');
  const [keyInput, setKeyInput] = useState('');
  const [editingKey, setEditingKey] = useState(false);

  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const keyInputRef = useRef<HTMLInputElement>(null);
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

  const fetchModels = useCallback(async () => {
    setLoading(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(
      loadOllamaModelsWithAutoStart(() => setStarting(true))
    );
    setStarting(false);
    if (exit._tag === 'Failure') {
      setError('Connection error');
    } else {
      const result = exit.value;
      switch (result._tag) {
        case 'ok':
          setModels(result.models as OllamaModel[]);
          break;
        case 'not-installed':
        case 'error':
          setError(result.message);
          break;
        case 'not-running':
          // Should not reach here (loadOllamaModelsWithAutoStart handles it internally); defensive fallback.
          setError('Ollama is not running');
          break;
      }
    }
    setLoading(false);
  }, []);

  // Load the effective connection config; prefill the base URL input with it.
  const applyConfig = useCallback((cfg: OllamaConfigInfo) => {
    setBaseUrlInput(cfg.baseUrl);
    setBaseUrlSource(cfg.baseUrlSource);
    setHasKey(cfg.hasKey);
    setMaskedKey(cfg.maskedKey);
    setKeySource(cfg.keySource);
    setKeyInput('');
    setEditingKey(false);
  }, []);

  const loadConfig = useCallback(async () => {
    setConfigLoading(true);
    setConfigError(null);
    const exit = await BrowserRuntime.runPromiseExit(loadOllamaConfig());
    if (exit._tag === 'Failure') {
      setConfigError('Failed to load config');
    } else {
      applyConfig(exit.value);
    }
    setConfigLoading(false);
  }, [applyConfig]);

  const toggle = () => {
    if (!open) {
      if (btnRef.current) {
        const rect = btnRef.current.getBoundingClientRect();
        // Compute position relative to portal target (panel wrapper) so the
        // popover lands at the trigger's visual position regardless of swipe.
        const origin = panelTarget?.getBoundingClientRect();
        const ox = origin?.left ?? 0;
        const oy = origin?.top ?? 0;
        setPos({ top: rect.bottom + 4 - oy, left: rect.left - ox });
      }
      loadConfig();
      fetchModels();
    }
    setOpen(v => !v);
  };

  // Persist baseUrl (may be empty → clears, falling back to env/default), then
  // re-fetch models since the list depends on the server URL.
  const handleSaveBaseUrl = async () => {
    setSavingConfig(true);
    setConfigError(null);
    const exit = await BrowserRuntime.runPromiseExit(
      saveOllamaConfig({ baseUrl: baseUrlInput })
    );
    if (exit._tag === 'Failure') {
      setConfigError('Save failed');
    } else {
      applyConfig(exit.value);
      await fetchModels();
    }
    setSavingConfig(false);
  };

  const handleSaveKey = async () => {
    const trimmed = keyInput.trim();
    if (!trimmed) return;
    setSavingConfig(true);
    setConfigError(null);
    const exit = await BrowserRuntime.runPromiseExit(
      saveOllamaConfig({ apiKey: trimmed })
    );
    if (exit._tag === 'Failure') {
      setConfigError('Save failed');
    } else {
      applyConfig(exit.value);
    }
    setSavingConfig(false);
  };

  const handleClearKey = async () => {
    setSavingConfig(true);
    setConfigError(null);
    const exit = await BrowserRuntime.runPromiseExit(
      saveOllamaConfig({ apiKey: '' })
    );
    if (exit._tag === 'Failure') {
      setConfigError('Clear failed');
    } else {
      applyConfig(exit.value);
    }
    setSavingConfig(false);
  };

  const beginEditKey = () => {
    setEditingKey(true);
    setKeyInput('');
    setTimeout(() => keyInputRef.current?.focus(), 0);
  };

  const selectModel = (name: string) => {
    onModelChange(name);
    setOpen(false);
  };

  const displayName = currentModel ? currentModel.replace(/:latest$/, '') : 'Select model';
  const baseHint = sourceHint(baseUrlSource);
  const keyHint = sourceHint(keySource);

  const menu = open ? (
    <Portal>
    <div
      ref={menuRef}
      className={`${ENGINE_MENU_CLASS} min-w-[300px]`}
      style={{ top: pos.top, left: pos.left }}
    >
      {/* Server URL section */}
      <div className="px-3 py-1.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">Server URL</span>
          {baseHint && !configLoading && (
            <span className="text-[10px] text-muted-foreground/70">{baseHint}</span>
          )}
        </div>
        {configLoading ? (
          <div className="flex items-center gap-2 py-1 text-xs text-muted-foreground">
            <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
            Loading...
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              type="text"
              value={baseUrlInput}
              onChange={(e) => setBaseUrlInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveBaseUrl(); }}
              placeholder="http://127.0.0.1:11434"
              spellCheck={false}
              className={`flex-1 min-w-0 text-xs px-2 py-1 rounded bg-secondary text-foreground border border-border focus:outline-none font-mono ${ENGINE_MENU_INPUT_FOCUS}`}
            />
            <button
              onClick={handleSaveBaseUrl}
              disabled={savingConfig}
              className={`text-[11px] px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${ENGINE_MENU_SAVE}`}
            >
              {savingConfig ? '...' : 'Save'}
            </button>
          </div>
        )}
      </div>

      {/* API Key section */}
      <div className="px-3 py-1.5">
        <div className="flex items-center justify-between mb-1.5">
          <span className="text-[11px] font-medium text-muted-foreground">API Key</span>
          {keyHint && hasKey && !configLoading && (
            <span className="text-[10px] text-muted-foreground/70">{keyHint}</span>
          )}
        </div>
        {configLoading ? null : hasKey && !editingKey ? (
          <div className="flex items-center gap-2">
            <code className="flex-1 min-w-0 truncate text-xs px-2 py-1 rounded bg-secondary text-foreground font-mono">
              {maskedKey}
            </code>
            <button
              onClick={beginEditKey}
              className="text-[11px] px-2 py-1 rounded bg-secondary hover:bg-hover text-foreground transition-colors"
              disabled={savingConfig}
            >
              Edit
            </button>
            <button
              onClick={handleClearKey}
              className="text-[11px] px-2 py-1 rounded text-red-11 hover:bg-red-500/10 transition-colors"
              disabled={savingConfig}
            >
              Clear
            </button>
          </div>
        ) : (
          <div className="flex items-center gap-2">
            <input
              ref={keyInputRef}
              type="password"
              value={keyInput}
              onChange={(e) => setKeyInput(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') handleSaveKey(); }}
              placeholder="optional — for authenticated servers"
              spellCheck={false}
              className={`flex-1 min-w-0 text-xs px-2 py-1 rounded bg-secondary text-foreground border border-border focus:outline-none font-mono ${ENGINE_MENU_INPUT_FOCUS}`}
            />
            <button
              onClick={handleSaveKey}
              disabled={savingConfig || !keyInput.trim()}
              className={`text-[11px] px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${ENGINE_MENU_SAVE}`}
            >
              {savingConfig ? '...' : 'Save'}
            </button>
            {hasKey && (
              <button
                onClick={() => { setEditingKey(false); setKeyInput(''); }}
                className="text-[11px] px-2 py-1 rounded text-muted-foreground hover:text-foreground transition-colors"
              >
                Cancel
              </button>
            )}
          </div>
        )}
        {configError && (
          <div className="mt-1 text-[11px] text-red-11">{configError}</div>
        )}
      </div>

      <div className="my-1 border-t border-border" />

      {/* Model section */}
      <div className="px-3 pt-1 pb-0.5">
        <span className="text-[11px] font-medium text-muted-foreground">Model</span>
      </div>
      <div className="max-h-[240px] overflow-y-auto">
        {loading || starting ? (
          <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
            <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
            {starting ? 'Starting Ollama...' : 'Loading models...'}
          </div>
        ) : error ? (
          <div className="px-3 py-2 text-xs text-red-11">{error}</div>
        ) : models.length === 0 ? (
          <div className="px-3 py-2 text-xs text-muted-foreground">
            No models found. Run <code className="bg-secondary px-1 rounded">ollama pull &lt;model&gt;</code>
          </div>
        ) : (
          models.map((m) => {
            const selected = m.name === currentModel;
            return (
              <button
                key={m.name}
                onClick={() => selectModel(m.name)}
                className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs transition-colors ${
                  selected ? ENGINE_MENU_ROW_SELECTED : 'text-foreground hover:bg-hover'
                }`}
              >
                <EngineCheck selected={selected} />
                <span className="truncate">{m.name.replace(/:latest$/, '')}</span>
                <span className="ml-auto pl-2 text-muted-foreground flex-shrink-0">
                  {m.parameter_size || formatSize(m.size)}
                </span>
              </button>
            );
          })
        )}
      </div>
    </div>
    </Portal>
  ) : null;

  return (
    <>
      <EnginePickerTrigger
        buttonRef={btnRef}
        label={displayName}
        title="Configure Ollama"
        onClick={toggle}
        icon={<EngineIcon engine="ollama" />}
        testId="ollama-config-picker"
      />
      {menu}
    </>
  );
}
