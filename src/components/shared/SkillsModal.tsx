'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { toast } from './Toast';
import { SkillPreviewModal } from './SkillPreviewModal';
import { notifySkillsChanged } from '@/lib/skills/skillsBus';

export interface SkillInfo {
  id: string;
  path: string;
  addedAt: string;
  name: string;
  description: string;
  icon?: string;
  argumentHint?: string;
  valid: boolean;
}

interface SkillsModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function SkillsModal({ isOpen, onClose }: SkillsModalProps) {
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [previewId, setPreviewId] = useState<string | null>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/skills');
      if (res.ok) {
        const data = (await res.json()) as SkillInfo[];
        setSkills(data);
      }
    } catch (err) {
      console.error('Failed to load skills', err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    if (isOpen) reload();
  }, [isOpen, reload]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        // If a sub-modal is open, let it handle ESC itself
        if (previewId) return;
        if (showAdd) {
          setShowAdd(false);
          setAddPath('');
          return;
        }
        onClose();
      }
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, onClose, showAdd, previewId]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return skills;
    return skills.filter(
      (s) =>
        s.name.toLowerCase().includes(q) ||
        s.description.toLowerCase().includes(q) ||
        s.path.toLowerCase().includes(q)
    );
  }, [skills, query]);

  const handleAdd = useCallback(async () => {
    const p = addPath.trim();
    if (!p) return;
    setAdding(true);
    try {
      const res = await fetch('/api/skills', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ path: p }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({}));
        toast(err.error || 'Failed to add skill', 'error');
        return;
      }
      toast('Skill added', 'success');
      setAddPath('');
      setShowAdd(false);
      await reload();
      notifySkillsChanged();
    } catch (err) {
      console.error(err);
      toast('Failed to add skill', 'error');
    } finally {
      setAdding(false);
    }
  }, [addPath, reload]);

  const handleDelete = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/skills/${encodeURIComponent(id)}`, {
          method: 'DELETE',
        });
        if (!res.ok) {
          toast('Failed to delete', 'error');
          return;
        }
        setSkills((prev) => prev.filter((s) => s.id !== id));
        notifySkillsChanged();
      } catch (err) {
        console.error(err);
        toast('Failed to delete', 'error');
      }
    },
    []
  );

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast('Path copied', 'success');
    } catch {
      toast('Failed to copy', 'error');
    }
  }, []);

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-black/50" onClick={onClose} />

        <div className="relative bg-card rounded-lg shadow-xl w-full max-w-3xl h-[80vh] mx-4 flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <h2 className="text-sm font-medium text-foreground">Skills</h2>
            <button
              onClick={onClose}
              className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
              title="Close"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>

          {/* Search + Add */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
            <div className="relative flex-1">
              <svg
                className="w-4 h-4 absolute left-2 top-1/2 -translate-y-1/2 text-muted-foreground"
                fill="none"
                stroke="currentColor"
                viewBox="0 0 24 24"
              >
                <circle cx="11" cy="11" r="7" strokeWidth={2} />
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-4.35-4.35" />
              </svg>
              <input
                type="text"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Search skills..."
                className="w-full pl-8 pr-3 py-1.5 text-sm border border-border rounded-md bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring"
              />
            </div>
            <button
              onClick={() => setShowAdd(true)}
              className="px-3 py-1.5 text-sm rounded-md bg-brand text-white hover:bg-teal-10 active:scale-95 transition-all"
            >
              + Add Skill
            </button>
          </div>

          {/* List */}
          <div className="flex-1 overflow-y-auto p-3 space-y-2">
            {loading ? (
              <div className="text-center text-muted-foreground py-8 text-sm">Loading...</div>
            ) : filtered.length === 0 ? (
              <div className="text-center text-muted-foreground py-8 text-sm">
                {skills.length === 0
                  ? 'No skills yet. Click "Add Skill" to add one.'
                  : 'No skills match your search.'}
              </div>
            ) : (
              filtered.map((skill) => (
                <SkillCard
                  key={skill.id}
                  skill={skill}
                  onPreview={() => setPreviewId(skill.id)}
                  onDelete={() => handleDelete(skill.id)}
                  onCopyPath={() => handleCopyPath(skill.path)}
                />
              ))
            )}
          </div>
        </div>
      </div>

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-black/50"
            onClick={() => {
              if (!adding) {
                setShowAdd(false);
                setAddPath('');
              }
            }}
          />
          <div className="relative bg-card rounded-lg shadow-xl w-full max-w-lg mx-4 p-5">
            <h3 className="text-sm font-medium text-foreground mb-3">Add Skill</h3>
            <label className="block text-xs text-muted-foreground mb-1">
              Absolute path to SKILL.md
            </label>
            <input
              type="text"
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !adding) handleAdd();
              }}
              placeholder="/Users/you/.../skills/foo/SKILL.md"
              autoFocus
              className="w-full px-3 py-2 text-sm font-mono border border-border rounded-md bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowAdd(false);
                  setAddPath('');
                }}
                disabled={adding}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleAdd}
                disabled={adding || !addPath.trim()}
                className="px-3 py-1.5 text-sm rounded-md bg-brand text-white hover:bg-teal-10 transition-colors disabled:opacity-50"
              >
                {adding ? 'Adding...' : 'Add'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Preview modal */}
      {previewId && (
        <SkillPreviewModal
          skillId={previewId}
          onClose={() => setPreviewId(null)}
        />
      )}
    </>
  );
}

// ============================================
// Card
// ============================================

interface SkillCardProps {
  skill: SkillInfo;
  onPreview: () => void;
  onDelete: () => void;
  onCopyPath: () => void;
}

function SkillCard({ skill, onPreview, onDelete, onCopyPath }: SkillCardProps) {
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <div
      className={`border border-border rounded-lg p-3 bg-card hover:bg-accent/30 transition-colors ${
        skill.valid ? '' : 'opacity-60'
      }`}
    >
      <div className="flex items-start gap-3">
        {/* Icon */}
        <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-md bg-brand/10 text-brand text-lg">
          {skill.icon ? (
            <span>{skill.icon}</span>
          ) : (
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path
                strokeLinecap="round"
                strokeLinejoin="round"
                strokeWidth={2}
                d="M12 3l1.9 4.8L19 9l-4.1 3.1L16 18l-4-2.8L8 18l1.1-5.9L5 9l5.1-1.2L12 3z"
              />
            </svg>
          )}
        </div>

        {/* Body */}
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="font-mono text-sm font-medium text-foreground">
              /{skill.name}
            </span>
            {skill.description && (
              <span className="text-sm text-muted-foreground line-clamp-2">
                {skill.description}
              </span>
            )}
            {!skill.valid && (
              <span className="text-xs px-1.5 py-0.5 rounded bg-red-9/15 text-red-11">
                Invalid
              </span>
            )}
          </div>
          {skill.argumentHint && (
            <div className="font-mono text-xs text-muted-foreground mt-0.5 truncate">
              {skill.argumentHint}
            </div>
          )}
          <div className="flex items-center gap-1 mt-1">
            <button
              onClick={onCopyPath}
              className="text-xs text-muted-foreground hover:text-foreground font-mono truncate text-left"
              title="Copy path"
            >
              {skill.path}
            </button>
          </div>
        </div>

        {/* Actions */}
        <div className="flex items-center gap-1 flex-shrink-0">
          <button
            onClick={onPreview}
            disabled={!skill.valid}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title="Preview"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15 12a3 3 0 11-6 0 3 3 0 016 0z" />
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M2.458 12C3.732 7.943 7.523 5 12 5c4.478 0 8.268 2.943 9.542 7-1.274 4.057-5.064 7-9.542 7-4.477 0-8.268-2.943-9.542-7z" />
            </svg>
          </button>
          {confirmDel ? (
            <>
              <button
                onClick={() => {
                  setConfirmDel(false);
                  onDelete();
                }}
                className="px-2 py-1 text-xs rounded bg-red-9 text-white hover:bg-red-10"
              >
                Confirm
              </button>
              <button
                onClick={() => setConfirmDel(false)}
                className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
              >
                Cancel
              </button>
            </>
          ) : (
            <button
              onClick={() => setConfirmDel(true)}
              className="p-1.5 text-muted-foreground hover:text-red-11 hover:bg-red-9/10 rounded transition-colors"
              title="Delete"
            >
              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
              </svg>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
