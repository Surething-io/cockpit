'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import type { DeepseekModel } from './types';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadAgentSettings,
  saveAgentSettings,
  loadDeepseekCredentials,
  loadDeepseekModels,
  saveDeepseekApiKey,
} from './effect/agentClient';

// Migrated from src/components/project/DeepseekConfigPicker.tsx.

/** SDK mode: the two ids DeepSeek's Anthropic-compatible endpoint accepts. Fixed — this
 *  endpoint has no model-listing API, and the server whitelists the same pair
 *  (engines/deepseek.ts ALLOWED_MODELS). Built-in Agent mode instead lists /v1/models live. */
const SDK_MODELS: { value: DeepseekModel; label: string }[] = [
  { value: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
  { value: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
];
const SDK_DEFAULT_MODEL = 'deepseek-v4-flash';

/** DeepSeek's console page where keys are created — the only place a user can get the
 *  value this menu asks for, so the field links straight to it. */
const API_KEYS_URL = 'https://platform.deepseek.com/api_keys';

interface DeepseekConfigPickerProps {
  currentModel?: DeepseekModel;
  onModelChange: (model: DeepseekModel) => void;
  /** Built-in Agent mode — different endpoint, so a different model namespace and a
   *  different settings key. See ChatMode in ./types. */
  builtin?: boolean;
  /** Fired whenever the persisted-key state changes (mount, save, clear, reopen). This
   *  component is the only live owner of that fact, so siblings that need it (the balance
   *  button) get it from here instead of caching their own copy and going stale. */
  onHasKeyChange?: (hasKey: boolean) => void;
}

export function DeepseekConfigPicker({ currentModel, onModelChange, builtin = false, onHasKeyChange }: DeepseekConfigPickerProps) {
  const [open, setOpen] = useState(false);
  const [hasKey, setHasKey] = useState(false); // whether a key is persisted
  const [maskedKey, setMaskedKey] = useState<string>(''); // server-masked display
  const [keyInput, setKeyInput] = useState<string>(''); // editable buffer
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Built-in Agent mode only: model ids fetched from /v1/models on open.
  const [builtinModels, setBuiltinModels] = useState<string[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  // Ref indirection for the mount-only effect below: it must read these once without the
  // parent's re-render churn (onModelChange gets a fresh identity every render) turning a
  // one-shot load into a loop.
  const builtinRef = useRef(builtin);
  const currentModelRef = useRef(currentModel);
  const onModelChangeRef = useRef(onModelChange);
  const onHasKeyChangeRef = useRef(onHasKeyChange);
  useEffect(() => {
    builtinRef.current = builtin;
    currentModelRef.current = currentModel;
    onModelChangeRef.current = onModelChange;
    onHasKeyChangeRef.current = onHasKeyChange;
  });

  // One notification point instead of four: hasKey is set on mount, on reopen, on save and
  // on clear, and every one of those must reach the parent.
  useEffect(() => {
    onHasKeyChangeRef.current?.(hasKey);
  }, [hasKey]);
  const [pos, setPos] = useState({ top: 0, left: 0 });
  const panelTarget = usePanelPortalTarget();

  // Resolve the button label on mount, not on first open: the label doubles as the key
  // indicator ("Set API key") and the model display, so deferring this to the popover left
  // every restored tab claiming no key was configured until the user clicked it.
  // Local-only calls (credentials + settings). The model LIST stays lazy — that one hits
  // DeepSeek over the network and is only needed once the popover is actually open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [credExit, settingsExit] = await Promise.all([
        BrowserRuntime.runPromiseExit(loadDeepseekCredentials()),
        BrowserRuntime.runPromiseExit(
          loadAgentSettings<{ engines?: { deepseek?: { model?: DeepseekModel; builtinModel?: DeepseekModel } } }>()
        ),
      ]);
      if (cancelled || credExit._tag === 'Failure') return;
      setHasKey(credExit.value.hasKey);
      setMaskedKey(credExit.value.maskedKey);
      const savedDeepseek = settingsExit._tag === 'Success' ? settingsExit.value?.engines?.deepseek : undefined;
      const savedModel = builtinRef.current ? savedDeepseek?.builtinModel : savedDeepseek?.model;
      // Only fill a gap — never overwrite the model this tab was restored with.
      if (!currentModelRef.current && savedModel) onModelChangeRef.current(savedModel);
    })();
    return () => { cancelled = true; };
  }, []);

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

  // Separate default per mode. The id sets overlap today, but SDK mode is whitelisted to a
  // fixed pair while Built-in Agent mode accepts anything /v1/models reports — sharing one
  // key would let a newer model chosen here become the SDK default, where it is silently
  // downgraded to DEFAULT_MODEL.
  const settingsKey = builtin ? 'builtinModel' : 'model';

  // Load settings on first open. The API key comes from its own credential
  // endpoint (masked, never raw); only the model lives in /api/settings.
  // In Built-in Agent mode the model list itself is fetched from /v1/models.
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setModelsError(null);
    const [credExit, settingsExit] = await Promise.all([
      BrowserRuntime.runPromiseExit(loadDeepseekCredentials()),
      BrowserRuntime.runPromiseExit(
        loadAgentSettings<{ engines?: { deepseek?: { model?: DeepseekModel; builtinModel?: DeepseekModel } } }>()
      ),
    ]);
    if (credExit._tag === 'Failure') {
      setError('Failed to load settings');
      setLoading(false);
      return;
    }
    setHasKey(credExit.value.hasKey);
    setMaskedKey(credExit.value.maskedKey);
    setKeyInput('');
    setEditing(false);

    const savedDeepseek = settingsExit._tag === 'Success' ? settingsExit.value?.engines?.deepseek : undefined;
    const savedModel = builtin ? savedDeepseek?.builtinModel : savedDeepseek?.model;

    if (builtin) {
      // Live list — an unreachable endpoint or a bad key surfaces here rather than at the
      // first chat turn. Without a key there is nothing to authenticate with, so skip.
      let available: string[] = [];
      if (credExit.value.hasKey) {
        const modelsExit = await BrowserRuntime.runPromiseExit(loadDeepseekModels());
        if (modelsExit._tag === 'Success') {
          available = modelsExit.value.models;
        } else {
          setModelsError('Failed to load models — check the API key');
        }
      }
      setBuiltinModels(available);
      // Sync a usable default upward: the saved one if the account still has it, else the
      // first available. Never leave the tab pointing at a model the endpoint rejects.
      const fallback = savedModel && available.includes(savedModel) ? savedModel : available[0];
      if (fallback && (!currentModel || !available.includes(currentModel))) {
        onModelChange(fallback);
      }
    } else if (!currentModel && savedModel && SDK_MODELS.some(m => m.value === savedModel)) {
      onModelChange(savedModel);
    }
    setLoading(false);
  }, [builtin, currentModel, onModelChange]);

  // Persist the model into /api/settings (shallow merge — send only the engines diff).
  const persistModel = useCallback(async (model: DeepseekModel) => {
    const curExit = await BrowserRuntime.runPromiseExit(
      loadAgentSettings<{ engines?: Record<string, Record<string, unknown>> }>()
    );
    const cur = curExit._tag === 'Success' ? curExit.value : {};
    const curEngines = cur.engines || {};
    const engines = {
      ...curEngines,
      deepseek: { ...(curEngines.deepseek || {}), [settingsKey]: model },
    };
    const saveExit = await BrowserRuntime.runPromiseExit(saveAgentSettings({ engines }));
    if (saveExit._tag === 'Failure') throw new Error('Failed to save settings');
  }, [settingsKey]);

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
    const exit = await BrowserRuntime.runPromiseExit(saveDeepseekApiKey(trimmed));
    if (exit._tag === 'Failure') {
      setError('Save failed');
    } else {
      setHasKey(exit.value.hasKey);
      setMaskedKey(exit.value.maskedKey);
      setKeyInput('');
      setEditing(false);
    }
    setSaving(false);
  };

  const handleClearKey = async () => {
    setSaving(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(saveDeepseekApiKey(''));
    if (exit._tag === 'Failure') {
      setError('Clear failed');
    } else {
      setHasKey(exit.value.hasKey);
      setMaskedKey(exit.value.maskedKey);
      setKeyInput('');
      setEditing(false);
    }
    setSaving(false);
  };

  const handleSelectModel = async (model: DeepseekModel) => {
    onModelChange(model);
    try {
      await persistModel(model);
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

  // In Built-in Agent mode there is no meaningful fallback id to show before the live list
  // arrives — the SDK default belongs to the other endpoint's namespace.
  const displayLabel = !hasKey
    ? 'Set API key'
    : (currentModel || (builtin ? 'Select model' : SDK_DEFAULT_MODEL));
  const labelTone = !hasKey ? 'text-amber-400' : 'text-sky-400';
  const modelOptions: { value: DeepseekModel; label: string }[] = builtin
    ? builtinModels.map((id) => ({ value: id, label: id }))
    : SDK_MODELS;
  const selectedModel = currentModel || (builtin ? '' : SDK_DEFAULT_MODEL);

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
              <div className="flex items-center gap-1 mb-1.5">
                <span className="text-[11px] font-medium text-muted-foreground">API Key</span>
                {/* Where the key comes from. `target="_blank"` matters beyond convention:
                    navigating in place would take the whole Cockpit window with it. */}
                <a
                  href={API_KEYS_URL}
                  target="_blank"
                  rel="noopener"
                  data-testid="deepseek-api-keys-link"
                  title="Open DeepSeek API keys page"
                  aria-label="Open DeepSeek API keys page"
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
              {hasKey && !editing ? (
                <div className="flex items-center gap-2">
                  <code className="flex-1 min-w-0 truncate text-xs px-2 py-1 rounded bg-secondary text-foreground font-mono">
                    {maskedKey}
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
              <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
                Model
                {builtin && <span className="ml-1 font-normal opacity-70">· Built-in Agent</span>}
              </div>
              {builtin && modelsError && (
                <div className="mb-1 text-[11px] text-red-400">{modelsError}</div>
              )}
              {builtin && !modelsError && modelOptions.length === 0 && (
                <div className="mb-1 text-[11px] text-muted-foreground">
                  {hasKey ? 'No models returned by /v1/models' : 'Save an API key to list models'}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {modelOptions.map((m) => {
                  const selected = selectedModel === m.value;
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
        title="Configure DeepSeek"
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
