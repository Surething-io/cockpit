'use client';

import React, { useState, useRef, useEffect, useCallback } from 'react';
import { Portal, usePanelPortalTarget } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { loadOllamaModelsWithAutoStart } from './effect/agentClient';

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

export function OllamaModelPicker({ currentModel, onModelChange }: OllamaModelPickerProps) {
  const [open, setOpen] = useState(false);
  const [models, setModels] = useState<OllamaModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
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
      fetchModels();
    }
    setOpen(v => !v);
  };

  const selectModel = (name: string) => {
    onModelChange(name);
    setOpen(false);
  };

  const displayName = currentModel ? currentModel.replace(/:latest$/, '') : 'Select model';

  const menu = open ? (
    <Portal>
    <div
      ref={menuRef}
      className="fixed z-[9999] bg-popover border border-border rounded-lg shadow-lg py-1 min-w-[200px] max-h-[300px] overflow-y-auto"
      style={{ top: pos.top, left: pos.left }}
    >
      {loading || starting ? (
        <div className="flex items-center gap-2 px-3 py-2 text-xs text-muted-foreground">
          <span className="w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin" />
          {starting ? 'Starting Ollama...' : 'Loading models...'}
        </div>
      ) : error ? (
        <div className="px-3 py-2 text-xs text-red-400">{error}</div>
      ) : models.length === 0 ? (
        <div className="px-3 py-2 text-xs text-muted-foreground">
          No models found. Run <code className="bg-secondary px-1 rounded">ollama pull &lt;model&gt;</code>
        </div>
      ) : (
        models.map((m) => (
          <button
            key={m.name}
            onClick={() => selectModel(m.name)}
            className={`w-full flex items-center justify-between gap-2 px-3 py-1.5 text-xs hover:bg-brand/10 transition-colors ${
              m.name === currentModel ? 'text-brand' : 'text-foreground'
            }`}
          >
            <span className="truncate">{m.name.replace(/:latest$/, '')}</span>
            <span className="text-muted-foreground flex-shrink-0">
              {m.parameter_size || formatSize(m.size)}
            </span>
          </button>
        ))
      )}
    </div>
    </Portal>
  ) : null;

  return (
    <>
      <button
        ref={btnRef}
        onClick={toggle}
        className="flex items-center gap-1 px-2 py-0.5 text-[11px] rounded bg-violet-500/15 text-violet-400 hover:bg-violet-500/25 transition-colors"
        title="Switch Ollama model"
      >
        <span className="w-1.5 h-1.5 rounded-full bg-violet-500 flex-shrink-0" />
        <span className="truncate max-w-[120px]">{displayName}</span>
        <svg className="w-3 h-3 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {menu}
    </>
  );
}
