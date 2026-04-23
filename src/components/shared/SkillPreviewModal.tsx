'use client';

import { useCallback, useEffect, useState } from 'react';
import { MarkdownRenderer } from './MarkdownRenderer';
import { SimpleCodeBlock } from '../project/CodeViewer';
import { toast } from './Toast';

interface SkillPreviewData {
  id: string;
  path: string;
  name: string;
  description: string;
  icon?: string;
  valid: boolean;
  content: string;
}

interface SkillPreviewModalProps {
  skillId: string;
  onClose: () => void;
}

type ViewMode = 'preview' | 'source';

export function SkillPreviewModal({ skillId, onClose }: SkillPreviewModalProps) {
  const [data, setData] = useState<SkillPreviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<ViewMode>('preview');

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    fetch(`/api/skills/content?id=${encodeURIComponent(skillId)}`)
      .then((res) => res.json())
      .then((d: SkillPreviewData) => {
        if (!cancelled) setData(d);
      })
      .catch((err) => console.error('Failed to load skill content', err))
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [skillId]);

  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [onClose]);

  const handleCopyPath = useCallback(async () => {
    if (!data?.path) return;
    try {
      await navigator.clipboard.writeText(data.path);
      toast('Path copied', 'success');
    } catch {
      toast('Failed to copy', 'error');
    }
  }, [data]);

  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center">
      <div className="absolute inset-0 bg-black/50" onClick={onClose} />

      <div className="relative bg-card rounded-lg shadow-xl w-full max-w-4xl h-[85vh] mx-4 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-sm font-medium text-foreground truncate">
                {data?.name ? `/${data.name}` : 'Skill Preview'}
              </h2>
              <button
                onClick={handleCopyPath}
                className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
                title="Copy path"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <rect x="9" y="9" width="13" height="13" rx="2" strokeWidth={2} />
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M5 15H4a2 2 0 01-2-2V4a2 2 0 012-2h9a2 2 0 012 2v1" />
                </svg>
              </button>
            </div>
            {data?.path && (
              <div className="text-xs text-muted-foreground font-mono truncate mt-0.5">
                {data.path}
              </div>
            )}
          </div>

          {/* Mode switcher */}
          <div className="flex items-center rounded-md border border-border overflow-hidden text-xs flex-shrink-0">
            <button
              onClick={() => setMode('preview')}
              className={`px-3 py-1 transition-colors ${
                mode === 'preview'
                  ? 'bg-brand text-white'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              Preview
            </button>
            <button
              onClick={() => setMode('source')}
              className={`px-3 py-1 transition-colors ${
                mode === 'source'
                  ? 'bg-brand text-white'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent'
              }`}
            >
              Source
            </button>
          </div>

          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors flex-shrink-0"
            title="Close"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Body */}
        <div className="flex-1 overflow-auto">
          {loading ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              Loading...
            </div>
          ) : !data || !data.valid ? (
            <div className="flex items-center justify-center py-12 text-muted-foreground text-sm">
              File cannot be read.
            </div>
          ) : mode === 'preview' ? (
            <div className="px-6 py-4">
              <MarkdownRenderer content={data.content} />
            </div>
          ) : (
            <SimpleCodeBlock
              content={data.content}
              filePath={data.path}
              className="min-h-full"
            />
          )}
        </div>
      </div>
    </div>
  );
}
