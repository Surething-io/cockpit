'use client';

import React, { useState, useRef, useEffect, useCallback, useMemo } from 'react';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import type { EngineModelId } from './types';
import { defaultRegionForLanguage } from '@cockpit/shared-utils';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import {
  loadAgentSettings,
  saveAgentSettings,
  loadEngineCredentials,
  loadEngineModels,
  revealEngineApiKey,
  saveEngineApiKey,
  type ApiKeyEngine,
  type EngineModelInfo,
} from './effect/agentClient';

/**
 * API key + model picker for the engines configured by key rather than by a local
 * CLI login (DeepSeek, Kimi, GLM). They have the same shape — one key, an
 * Anthropic-compatible endpoint for SDK mode and an OpenAI-compatible one for
 * Built-in Agent mode — so they share this component and differ only in ENGINES
 * below.
 *
 * Two real behavioural differences, both expressed as config:
 * - Where SDK-mode model ids come from. DeepSeek's Anthropic-compatible endpoint has
 *   no listing API (hence a fixed pair, mirrored by ALLOWED_MODELS in
 *   engines/deepseek.ts), while Kimi and GLM list live models for both protocols and
 *   gate them by plan — a hardcoded list would offer models the account cannot call.
 * - Whether the provider is served from more than one host (GLM's `regions`).
 */

type Accent = 'sky' | 'purple' | 'amber';

/** Tailwind classes must be literal strings — a `bg-${accent}-500` template never
 *  reaches the generated CSS. */
const ACCENTS: Record<Accent, {
  dot: string; trigger: string; label: string; chevron: string;
  inputFocus: string; save: string; selectedRow: string; radio: string; radioDot: string;
}> = {
  sky: {
    dot: 'bg-sky-500',
    trigger: 'bg-sky-500/15 hover:bg-sky-500/25',
    label: 'text-sky-400',
    chevron: 'text-sky-400',
    inputFocus: 'focus:border-sky-500',
    save: 'bg-sky-500/20 hover:bg-sky-500/30 text-sky-300',
    selectedRow: 'bg-sky-500/15 text-sky-300',
    radio: 'border-sky-400',
    radioDot: 'bg-sky-400',
  },
  purple: {
    dot: 'bg-purple-500',
    trigger: 'bg-purple-500/15 hover:bg-purple-500/25',
    label: 'text-purple-400',
    chevron: 'text-purple-400',
    inputFocus: 'focus:border-purple-500',
    save: 'bg-purple-500/20 hover:bg-purple-500/30 text-purple-300',
    selectedRow: 'bg-purple-500/15 text-purple-300',
    radio: 'border-purple-400',
    radioDot: 'bg-purple-400',
  },
  amber: {
    dot: 'bg-amber-500',
    trigger: 'bg-amber-500/15 hover:bg-amber-500/25',
    label: 'text-amber-400',
    chevron: 'text-amber-400',
    inputFocus: 'focus:border-amber-500',
    save: 'bg-amber-500/20 hover:bg-amber-500/30 text-amber-300',
    selectedRow: 'bg-amber-500/15 text-amber-300',
    radio: 'border-amber-400',
    radioDot: 'bg-amber-400',
  },
};

interface EngineUiConfig {
  /** Human-readable provider name, used in every label and tooltip. */
  label: string;
  accent: Accent;
  /** Console page where keys are created — the only place a user can get the value
   *  this menu asks for, so the field links straight to it. */
  apiKeysUrl: string;
  /** SDK-mode model ids: a fixed list, or 'live' to use the same listing endpoint
   *  Built-in Agent mode uses. */
  sdkModels: { id: string; label: string }[] | 'live';
  /** Shown as the trigger label before the user has chosen anything (fixed lists only). */
  sdkDefaultModel?: string;
  /** Listing endpoint path, quoted in the empty-state message. */
  modelsEndpoint: string;
  /**
   * Providers served from more than one host. The same key works on all of them, so this
   * is a routing preference: the UI language picks the initial one, and this row exists so
   * a user whose language and account do not line up is not stuck.
   */
  regions?: { id: string; label: string; hint: string }[];
}

const ENGINES: Record<ApiKeyEngine, EngineUiConfig> = {
  deepseek: {
    label: 'DeepSeek',
    accent: 'sky',
    apiKeysUrl: 'https://platform.deepseek.com/api_keys',
    sdkModels: [
      { id: 'deepseek-v4-flash', label: 'deepseek-v4-flash' },
      { id: 'deepseek-v4-pro', label: 'deepseek-v4-pro' },
    ],
    sdkDefaultModel: 'deepseek-v4-flash',
    modelsEndpoint: '/v1/models',
  },
  kimi: {
    label: 'Kimi',
    accent: 'purple',
    apiKeysUrl: 'https://www.kimi.com/code/console',
    sdkModels: 'live',
    modelsEndpoint: '/coding/v1/models',
  },
  glm: {
    label: 'GLM',
    accent: 'amber',
    apiKeysUrl: 'https://bigmodel.cn/apikey/platform',
    sdkModels: 'live',
    modelsEndpoint: '/coding/paas/v4/models',
    regions: [
      { id: 'cn', label: '中国大陆', hint: 'open.bigmodel.cn' },
      { id: 'global', label: 'International', hint: 'api.z.ai' },
    ],
  },
};

/** 1048576 → '1M', 262144 → '256K'. */
function formatContext(tokens?: number): string | null {
  if (!tokens || tokens <= 0) return null;
  if (tokens >= 1024 * 1024) return `${Math.round(tokens / (1024 * 1024))}M`;
  return `${Math.round(tokens / 1024)}K`;
}

interface EngineConfigPickerProps {
  engine: ApiKeyEngine;
  currentModel?: EngineModelId;
  onModelChange: (model: EngineModelId) => void;
  /** Built-in Agent mode — different endpoint, so a different model namespace and a
   *  different settings key. See ChatMode in ./types. */
  builtin?: boolean;
  /** Fired whenever the persisted-key state changes (mount, save, clear, reopen). This
   *  component is the only live owner of that fact, so siblings that need it (the balance
   *  / quota button) get it from here instead of caching their own copy and going stale. */
  onHasKeyChange?: (hasKey: boolean) => void;
}

interface EngineSettingsSlice {
  model?: string;
  builtinModel?: string;
  modelContextTokens?: number;
  modelEffort?: string;
  region?: string;
}

export function EngineConfigPicker({
  engine,
  currentModel,
  onModelChange,
  builtin = false,
  onHasKeyChange,
}: EngineConfigPickerProps) {
  const config = ENGINES[engine];
  const accent = ACCENTS[config.accent];
  // SDK mode uses the live list too when the provider has no fixed set (Kimi).
  const liveModels = builtin || config.sdkModels === 'live';

  const [open, setOpen] = useState(false);
  const [hasKey, setHasKey] = useState(false); // whether a key is persisted
  const [maskedKey, setMaskedKey] = useState<string>(''); // server-masked display
  const [keyInput, setKeyInput] = useState<string>(''); // editable buffer
  const [editing, setEditing] = useState(false);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // 'copied' shows the confirmation inline for a moment — this popover has no toast host.
  const [copied, setCopied] = useState(false);
  // Models fetched from the provider's listing endpoint on open (live modes only).
  const [fetchedModels, setFetchedModels] = useState<EngineModelInfo[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  // Effective region for multi-region providers. Resolved the SAME way the server does
  // (defaultRegionForLanguage over the PERSISTED settings.language) so the row can never
  // claim one host while the runs go to another.
  const [region, setRegion] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copiedTimer.current) clearTimeout(copiedTimer.current); }, []);
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
  // the provider over the network and is only needed once the popover is actually open.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const [credExit, settingsExit] = await Promise.all([
        BrowserRuntime.runPromiseExit(loadEngineCredentials(engine)),
        BrowserRuntime.runPromiseExit(
          loadAgentSettings<{ engines?: Record<string, EngineSettingsSlice | undefined> }>()
        ),
      ]);
      if (cancelled || credExit._tag === 'Failure') return;
      setHasKey(credExit.value.hasKey);
      setMaskedKey(credExit.value.maskedKey);
      const savedEngine = settingsExit._tag === 'Success' ? settingsExit.value?.engines?.[engine] : undefined;
      const savedModel = builtinRef.current ? savedEngine?.builtinModel : savedEngine?.model;
      // Only fill a gap — never overwrite the model this tab was restored with.
      if (!currentModelRef.current && savedModel) onModelChangeRef.current(savedModel);
    })();
    return () => { cancelled = true; };
  }, [engine]);

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

  // Separate default per mode. The id sets can overlap, but the two modes talk to
  // different endpoints — sharing one key would let a model chosen for one of them
  // become the other's default, where it may not exist at all.
  const settingsKey = builtin ? 'builtinModel' : 'model';

  const staticOptions = useMemo(
    () => (config.sdkModels === 'live' ? [] : config.sdkModels.map((m) => ({ id: m.id, label: m.label }))),
    [config.sdkModels]
  );

  // Load settings on first open. The API key comes from its own credential
  // endpoint (masked, never raw); only the model lives in /api/settings.
  const loadSettings = useCallback(async () => {
    setLoading(true);
    setError(null);
    setModelsError(null);
    const [credExit, settingsExit] = await Promise.all([
      BrowserRuntime.runPromiseExit(loadEngineCredentials(engine)),
      BrowserRuntime.runPromiseExit(
        loadAgentSettings<{
          engines?: Record<string, EngineSettingsSlice | undefined>;
          language?: string;
        }>()
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

    const settings = settingsExit._tag === 'Success' ? settingsExit.value : undefined;
    const savedEngine = settings?.engines?.[engine];
    const savedModel = builtin ? savedEngine?.builtinModel : savedEngine?.model;
    if (config.regions) {
      setRegion(savedEngine?.region ?? defaultRegionForLanguage(settings?.language));
    }

    if (liveModels) {
      // Live list — an unreachable endpoint or a bad key surfaces here rather than at the
      // first chat turn. Without a key there is nothing to authenticate with, so skip.
      let available: EngineModelInfo[] = [];
      if (credExit.value.hasKey) {
        const modelsExit = await BrowserRuntime.runPromiseExit(loadEngineModels(engine));
        if (modelsExit._tag === 'Success') {
          available = modelsExit.value.models;
        } else {
          setModelsError('Failed to load models — check the API key');
        }
      }
      setFetchedModels(available);
      // Sync a usable default upward: the saved one if the account still has it, else the
      // first available. Never leave the tab pointing at a model the endpoint rejects.
      const ids = available.map((m) => m.id);
      const fallback = savedModel && ids.includes(savedModel) ? savedModel : ids[0];
      if (fallback && (!currentModel || !ids.includes(currentModel))) {
        onModelChange(fallback);
      }
    } else if (!currentModel && savedModel && staticOptions.some((m) => m.id === savedModel)) {
      onModelChange(savedModel);
    }
    setLoading(false);
  }, [engine, builtin, liveModels, currentModel, onModelChange, staticOptions, config.regions]);

  // Persist the model into /api/settings (shallow merge — send only the engines diff).
  // SDK mode also stores the model's context window and effort default so the engine can
  // build the SDK env without a round trip to the provider at chat start.
  const persistModel = useCallback(async (model: EngineModelId, meta?: EngineModelInfo) => {
    const curExit = await BrowserRuntime.runPromiseExit(
      loadAgentSettings<{ engines?: Record<string, Record<string, unknown>> }>()
    );
    const cur = curExit._tag === 'Success' ? curExit.value : {};
    const curEngines = cur.engines || {};
    const engines = {
      ...curEngines,
      [engine]: {
        ...(curEngines[engine] || {}),
        [settingsKey]: model,
        ...(!builtin && meta?.contextTokens ? { modelContextTokens: meta.contextTokens } : {}),
        ...(!builtin && meta?.effort ? { modelEffort: meta.effort } : {}),
      },
    };
    const saveExit = await BrowserRuntime.runPromiseExit(saveAgentSettings({ engines }));
    if (saveExit._tag === 'Failure') throw new Error('Failed to save settings');
  }, [engine, settingsKey, builtin]);

  // Region is a routing preference, so it persists like the model and takes effect on the
  // next request — including the model list, which is why this reloads it.
  const handleSelectRegion = useCallback(async (id: string) => {
    setRegion(id);
    const curExit = await BrowserRuntime.runPromiseExit(
      loadAgentSettings<{ engines?: Record<string, Record<string, unknown>> }>()
    );
    const cur = curExit._tag === 'Success' ? curExit.value : {};
    const curEngines = cur.engines || {};
    const saveExit = await BrowserRuntime.runPromiseExit(
      saveAgentSettings({
        engines: { ...curEngines, [engine]: { ...(curEngines[engine] || {}), region: id } },
      })
    );
    if (saveExit._tag === 'Failure') {
      setError('Failed to save region');
      return;
    }
    loadSettings();
  }, [engine, loadSettings]);

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
    const exit = await BrowserRuntime.runPromiseExit(saveEngineApiKey(engine, trimmed));
    if (exit._tag === 'Failure') {
      setError('Save failed');
    } else {
      setHasKey(exit.value.hasKey);
      setMaskedKey(exit.value.maskedKey);
      setKeyInput('');
      setEditing(false);
      // A fresh key usually means a different account, and in live-list mode the model
      // options are account-scoped — reload them instead of showing the old tier's list.
      if (liveModels) loadSettings();
    }
    setSaving(false);
  };

  const handleClearKey = async () => {
    setSaving(true);
    setError(null);
    const exit = await BrowserRuntime.runPromiseExit(saveEngineApiKey(engine, ''));
    if (exit._tag === 'Failure') {
      setError('Clear failed');
    } else {
      setHasKey(exit.value.hasKey);
      setMaskedKey(exit.value.maskedKey);
      setKeyInput('');
      setEditing(false);
      if (liveModels) setFetchedModels([]);
    }
    setSaving(false);
  };

  /**
   * Copy the real key. The UI only ever holds the masked form, so the plaintext is
   * fetched on demand (`?reveal=1`) and handed straight to the clipboard — it is
   * never kept in state, where a re-render could paint it on screen.
   */
  const handleCopyKey = async () => {
    const exit = await BrowserRuntime.runPromiseExit(revealEngineApiKey(engine));
    if (exit._tag === 'Failure' || !exit.value.apiKey) {
      setError('Copy failed');
      return;
    }
    try {
      await navigator.clipboard.writeText(exit.value.apiKey);
    } catch {
      // Clipboard is permission-gated (and absent on insecure origins) — say so
      // rather than silently claiming success.
      setError('Clipboard unavailable');
      return;
    }
    setError(null);
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), 1500);
  };

  /** Switch the key field into edit mode and focus it once React has rendered the input. */
  const beginEdit = () => {
    setEditing(true);
    setKeyInput('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };

  const handleSelectModel = async (model: EngineModelId, meta?: EngineModelInfo) => {
    onModelChange(model);
    try {
      await persistModel(model, meta);
    } catch {
      // non-fatal — tab state already updated
    }
  };

  const modelOptions: EngineModelInfo[] = liveModels
    ? fetchedModels
    : staticOptions.map((m) => ({ id: m.id, label: m.label }));

  // With a live list there is no meaningful fallback id to show before it arrives.
  const displayLabel = !hasKey
    ? 'Set API key'
    : (currentModel || (liveModels ? 'Select model' : config.sdkDefaultModel ?? 'Select model'));
  const labelTone = !hasKey ? 'text-amber-400' : accent.label;
  const selectedModel = currentModel || (liveModels ? '' : config.sdkDefaultModel ?? '');

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
                  href={config.apiKeysUrl}
                  target="_blank"
                  rel="noopener"
                  data-testid={`${engine}-api-keys-link`}
                  title={`Open ${config.label} API keys page`}
                  aria-label={`Open ${config.label} API keys page`}
                  className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M10 6H6a2 2 0 00-2 2v10a2 2 0 002 2h10a2 2 0 002-2v-4M14 4h6m0 0v6m0-6L10 14" />
                  </svg>
                </a>
              </div>
              {hasKey && !editing ? (
                <div className="flex items-center gap-1.5">
                  <code className="flex-1 min-w-0 truncate text-xs px-2 py-1 rounded bg-secondary text-foreground font-mono">
                    {maskedKey}
                  </code>
                  {/* Icon-only: the row already carries two text buttons and the popover is
                      280px wide, so a third label would push the masked key to nothing. */}
                  <button
                    onClick={handleCopyKey}
                    data-testid={`${engine}-copy-api-key`}
                    title={copied ? 'Copied' : 'Copy API key'}
                    aria-label="Copy API key"
                    className={`p-1 rounded transition-colors ${copied ? 'text-emerald-400' : 'text-muted-foreground hover:text-foreground hover:bg-accent'}`}
                    disabled={saving}
                  >
                    {copied ? (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 13l4 4L19 7" />
                      </svg>
                    ) : (
                      <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                      </svg>
                    )}
                  </button>
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
                    className={`flex-1 min-w-0 text-xs px-2 py-1 rounded bg-secondary text-foreground border border-border focus:outline-none font-mono ${accent.inputFocus}`}
                    autoFocus
                  />
                  <button
                    onClick={handleSaveKey}
                    disabled={saving || !keyInput.trim()}
                    className={`text-[11px] px-2 py-1 rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed ${accent.save}`}
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

            {/* Region section — multi-region providers only. The same key authenticates on
                every host, so this changes the route and nothing else: existing sessions
                stay resumable (the store is per engine, not per host). */}
            {config.regions && (
              <>
                <div className="px-3 py-1.5">
                  <div className="text-[11px] font-medium text-muted-foreground mb-1.5">Region</div>
                  <div className="inline-flex rounded-md border border-border overflow-hidden text-xs" role="group" data-testid={`${engine}-region-toggle`}>
                    {config.regions.map((r) => (
                      <button
                        key={r.id}
                        type="button"
                        data-testid={`${engine}-region-${r.id}`}
                        onClick={() => handleSelectRegion(r.id)}
                        title={r.hint}
                        className={`px-2 py-0.5 ${region === r.id ? 'bg-brand text-white' : 'bg-transparent text-muted-foreground hover:bg-accent'}`}
                      >
                        {r.label}
                      </button>
                    ))}
                  </div>
                </div>
                <div className="my-1 border-t border-border" />
              </>
            )}

            {/* Model section */}
            <div className="px-3 py-1.5">
              <div className="text-[11px] font-medium text-muted-foreground mb-1.5">
                Model
                {builtin && <span className="ml-1 font-normal opacity-70">· Built-in Agent</span>}
              </div>
              {liveModels && modelsError && (
                <div className="mb-1 text-[11px] text-red-400">{modelsError}</div>
              )}
              {liveModels && !modelsError && modelOptions.length === 0 && (
                <div className="mb-1 text-[11px] text-muted-foreground">
                  {hasKey ? `No models returned by ${config.modelsEndpoint}` : 'Save an API key to list models'}
                </div>
              )}
              <div className="flex flex-col gap-0.5">
                {modelOptions.map((m) => {
                  const selected = selectedModel === m.id;
                  const context = formatContext(m.contextTokens);
                  return (
                    <button
                      key={m.id}
                      onClick={() => handleSelectModel(m.id, m)}
                      className={`flex items-center gap-2 px-2 py-1 text-xs rounded transition-colors ${
                        selected ? accent.selectedRow : 'text-foreground hover:bg-accent'
                      }`}
                    >
                      <span className={`w-3 h-3 rounded-full border-2 flex items-center justify-center ${
                        selected ? accent.radio : 'border-muted-foreground'
                      }`}>
                        {selected && <span className={`w-1.5 h-1.5 rounded-full ${accent.radioDot}`} />}
                      </span>
                      <span className="truncate">{m.id}</span>
                      {/* The id is what the engine sends and what a bug report needs, so it
                          stays primary; the provider's display name only earns space when it
                          says something the id doesn't (kimi-for-coding → "K2.7 Coding"). */}
                      {m.label && m.label !== m.id && (
                        <span className="truncate text-[10px] text-muted-foreground">{m.label}</span>
                      )}
                      {context && (
                        <span className="ml-auto pl-2 text-[10px] text-muted-foreground flex-shrink-0">{context}</span>
                      )}
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
        className={`flex items-center gap-1 px-2 py-0.5 text-[11px] rounded transition-colors ${accent.trigger}`}
        title={`Configure ${config.label}`}
        data-testid={`${engine}-config-picker`}
      >
        <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${accent.dot}`} />
        <span className={`truncate max-w-[160px] ${labelTone}`}>{displayLabel}</span>
        <svg className={`w-3 h-3 flex-shrink-0 ${accent.chevron}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {menu}
    </>
  );
}

/** Switch the key field into edit mode and focus it once React has rendered the input. */
function beginEditFactory(
  setEditing: (v: boolean) => void,
  setKeyInput: (v: string) => void,
  inputRef: React.RefObject<HTMLInputElement | null>,
) {
  return () => {
    setEditing(true);
    setKeyInput('');
    setTimeout(() => inputRef.current?.focus(), 0);
  };
}
