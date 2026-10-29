'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Joystick } from 'lucide-react';
import { toast, MODAL_SHELL_CLASS } from '@cockpit/shared-ui';
import {
  loadSkillsList,
  loadBuiltinSkills,
  addSkill,
  deleteSkill,
  notifySkillsChanged,
} from '@cockpit/shared-api';
import { SkillPreviewPane } from './SkillPreviewPane';
import { BrowserRuntime } from '@cockpit/effect-runtime';

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

const BUILTIN_GROUP = 'builtin';

/** The folder a skill was registered from: its path minus `<skill>/SKILL.md`. */
const sourceDirOf = (path: string) => path.split('/').slice(0, -2).join('/') || '/';

/** Home directory shown as `~`, as a shell would. */
const tildify = (path: string) => path.replace(/^\/(?:Users|home)\/[^/]+(?=\/|$)/, '~');

/**
 * SkillsModal — the skills board: every skill on the left, grouped by the
 * folder it was registered from (largest group first) with the builtin skills
 * last, and the selected skill's SKILL.md on the right (SkillPreviewPane).
 *
 * Builtins ship with the package: read-only, no delete. Their ids are
 * `builtin:<cmd>` (server lib/builtinSkillsList), which the content route
 * accepts and the delete route never sees.
 */
export function SkillsModal({ isOpen, onClose }: SkillsModalProps) {
  const { t, i18n } = useTranslation();
  const [skills, setSkills] = useState<SkillInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [builtins, setBuiltins] = useState<SkillInfo[]>([]);
  // Which skill the right-hand pane shows.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const exit = await BrowserRuntime.runPromiseExit(loadSkillsList<SkillInfo>());
    if (exit._tag === 'Success') {
      setSkills(exit.value as SkillInfo[]);
    } else {
      console.error('Failed to load skills', exit.cause);
    }
    const builtinExit = await BrowserRuntime.runPromiseExit(loadBuiltinSkills<SkillInfo>());
    if (builtinExit._tag === 'Success') setBuiltins(builtinExit.value as SkillInfo[]);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (!isOpen) {
      setSelectedId(null);
      setConfirmDeleteId(null);
    }
    if (isOpen) {
      reload();
      // Focus and select the retained keyword so typing replaces it
      setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 100);
    }
  }, [isOpen, reload]);

  // ESC to close
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
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
  }, [isOpen, onClose, showAdd]);

  const matches = useCallback((s: SkillInfo) => {
    const q = query.trim().toLowerCase();
    return !q ||
      s.name.toLowerCase().includes(q) ||
      s.description.toLowerCase().includes(q) ||
      s.path.toLowerCase().includes(q);
  }, [query]);

  // Registered skills by source folder, largest folder first (then by path);
  // names sorted inside a folder; builtins as the last group.
  const groups = useMemo(() => {
    const byDir = new Map<string, SkillInfo[]>();
    for (const s of skills) {
      if (!matches(s)) continue;
      const dir = sourceDirOf(s.path);
      const list = byDir.get(dir);
      if (list) list.push(s);
      else byDir.set(dir, [s]);
    }
    const out = [...byDir.entries()]
      .sort(([a, x], [b, y]) => y.length - x.length || a.localeCompare(b))
      .map(([dir, items]) => ({ key: dir, items: [...items].sort((x, y) => x.name.localeCompare(y.name)) }));
    const visibleBuiltins = builtins.filter(matches);
    if (visibleBuiltins.length > 0) out.push({ key: BUILTIN_GROUP, items: visibleBuiltins });
    return out;
  }, [skills, builtins, matches]);

  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups]);
  const selected = selectedId ? [...skills, ...builtins].find((s) => s.id === selectedId) ?? null : null;

  // Auto-select the first row so the board opens on a SKILL.md. Only fills a
  // hole (nothing selected, or the selection was deleted).
  useEffect(() => {
    if (!isOpen || selected) return;
    setSelectedId(flat[0]?.id ?? null);
  }, [isOpen, selected, flat]);
  const docsUrl = i18n.resolvedLanguage?.startsWith('zh')
    ? 'https://opencockpit.dev/zh/docs/agent/skills/'
    : 'https://opencockpit.dev/en/docs/agent/skills/';

  const handleAdd = useCallback(async () => {
    const p = addPath.trim();
    if (!p) return;
    setAdding(true);
    const exit = await BrowserRuntime.runPromiseExit(addSkill(p));
    if (exit._tag === 'Success') {
      toast(exit.value.alreadyExists ? t('skills.alreadyAdded') : t('skills.added'), exit.value.alreadyExists ? 'info' : 'success');
      setAddPath('');
      setShowAdd(false);
      await reload();
      if (!exit.value.alreadyExists) notifySkillsChanged();
    } else {
      // Surface the underlying Error.message (may be the backend's body.error)
      const failure = exit.cause._tag === 'Fail' ? exit.cause.error : null;
      const inner = failure?.cause;
      const msg = inner instanceof Error ? inner.message : t('skills.addFailed');
      toast(msg, 'error');
    }
    setAdding(false);
  }, [addPath, reload, t]);

  const handleDelete = useCallback(
    async (id: string) => {
      const exit = await BrowserRuntime.runPromiseExit(deleteSkill(id));
      if (exit._tag === 'Success') {
        setSkills((prev) => prev.filter((s) => s.id !== id));
        notifySkillsChanged();
      } else {
        toast(t('common.deleteFailed'), 'error');
      }
    },
    [t]
  );

  if (!isOpen) return null;

  return (
    <>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div className="absolute inset-0 bg-scrim" onClick={onClose} />

        <div className={MODAL_SHELL_CLASS}>
          {/* Header — title + inline search/add/close (matches SessionBrowser) */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <h2 className="text-sm font-medium text-foreground">{t('skills.title')}</h2>
            <div className="flex items-center gap-3">
              <div className="relative">
                <input
                  ref={searchInputRef}
                  type="text"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder={t('skills.searchPlaceholder')}
                  className="px-2 py-1 pr-6 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                />
                {query && (
                  <button
                    onClick={() => {
                      setQuery('');
                      searchInputRef.current?.focus();
                    }}
                    className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-foreground-subtle hover:text-foreground rounded-sm transition-colors"
                    title={t('skills.clearSearch')}
                  >
                    <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                      <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                    </svg>
                  </button>
                )}
              </div>
              <button
                onClick={() => setShowAdd(true)}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                </svg>
                {t('skills.addSkill')}
              </button>
              <button
                onClick={onClose}
                className="p-1 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors"
                title={t('common.close')}
              >
                <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </div>
          </div>

          {/* Body — grouped list on the left, the selected SKILL.md on the right */}
          {loading && skills.length === 0 && builtins.length === 0 ? (
            <div className="flex-1 text-center text-muted-foreground py-8 text-sm">{t('common.loading')}</div>
          ) : (
            <div className="flex-1 flex min-h-0">
              {/* Left. Padding stays off the scroll node so the sticky group
                  header does not leave a strip of rows visible above it. */}
              <div className="w-full md:w-[340px] min-h-0 flex-shrink-0 md:border-r border-border overflow-y-auto">
                {skills.length === 0 && (
                  // No skill of the user's own yet: the old empty state, above
                  // the builtins so it is still the first thing read.
                  <div className="text-center text-muted-foreground px-4 pt-6 pb-2 text-xs space-y-2">
                    <p>{t('skills.emptyNoSkills')}</p>
                    <p>
                      {t('skills.emptyIntroPrefix')}{' '}
                      <code className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-xs">/skillify</code>
                      {' '}{t('skills.emptyIntroSuffix')}
                    </p>
                    <p>
                      <button type="button" onClick={() => setShowAdd(true)} className="text-brand hover:underline">
                        {t('skills.addSkill')}
                      </button>
                      {' · '}
                      <a href={docsUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                        {t('skills.viewDocs')}
                      </a>
                    </p>
                  </div>
                )}
                <div className="p-3 space-y-3">
                  {groups.length === 0 && query ? (
                    <div className="text-center text-muted-foreground py-6 text-xs">{t('skills.emptyNoMatch')}</div>
                  ) : (
                    groups.map((group) => (
                      /* One card per group. No overflow-hidden here: it would
                         make the card the sticky header's scroll container. */
                      <div key={group.key} className="rounded-lg border border-border">
                        <div
                          className="sticky top-0 z-10 px-3 py-1.5 bg-card rounded-t-lg border-b border-border/60 text-[11px] font-medium text-muted-foreground flex items-center gap-1.5"
                          data-tooltip={group.key === BUILTIN_GROUP ? undefined : group.key}
                        >
                          <span className="truncate font-mono">
                            {group.key === BUILTIN_GROUP ? t('skills.builtinGroup') : tildify(group.key)}
                          </span>
                          <span className="ml-auto tabular-nums text-foreground-subtle">{group.items.length}</span>
                        </div>
                        <div className="p-1 space-y-0.5">
                          {group.items.map((skill) => (
                            <SkillRow
                              key={skill.id}
                              skill={skill}
                              selected={skill.id === selectedId}
                              onSelect={() => { setSelectedId(skill.id); setConfirmDeleteId(null); }}
                            />
                          ))}
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>

              {/* Right: the selected skill */}
              <div className="hidden md:flex flex-1 min-w-0">
                {selected ? (
                  <SkillPreviewPane
                    // Remount per skill: content and the preview/source mode reset.
                    key={selected.id}
                    skillId={selected.id}
                    name={selected.name}
                    onClose={onClose}
                    actions={
                      selected.id.startsWith('builtin:') ? (
                        <span className="text-[11px] text-foreground-subtle flex-shrink-0">{t('skills.builtinReadOnly')}</span>
                      ) : confirmDeleteId === selected.id ? (
                        <div className="flex items-center gap-1 flex-shrink-0">
                          <button
                            onClick={() => { setConfirmDeleteId(null); handleDelete(selected.id); }}
                            className="px-2 py-1 text-xs rounded bg-red-9 text-white hover:bg-red-10"
                          >
                            {t('common.confirm')}
                          </button>
                          <button
                            onClick={() => setConfirmDeleteId(null)}
                            className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground"
                          >
                            {t('common.cancel')}
                          </button>
                        </div>
                      ) : (
                        <button
                          onClick={() => setConfirmDeleteId(selected.id)}
                          className="p-1.5 text-muted-foreground hover:text-red-11 hover:bg-red-9/10 rounded transition-colors flex-shrink-0"
                          title={t('common.delete')}
                        >
                          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6M1 7h22M9 7V4a1 1 0 011-1h4a1 1 0 011 1v3" />
                          </svg>
                        </button>
                      )
                    }
                  />
                ) : (
                  <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                    {t('skills.selectHint')}
                  </div>
                )}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Add modal */}
      {showAdd && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div
            className="absolute inset-0 bg-scrim"
            onClick={() => {
              if (!adding) {
                setShowAdd(false);
                setAddPath('');
              }
            }}
          />
          <div className="relative bg-card rounded-lg shadow-lv3 w-full max-w-lg mx-4 p-5">
            <h3 className="text-sm font-medium text-foreground mb-3">{t('skills.addSkill')}</h3>
            <label className="block text-xs text-muted-foreground mb-1">
              {t('skills.pathLabel')}
            </label>
            <input
              type="text"
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !adding) handleAdd();
              }}
              placeholder={t('skills.pathPlaceholder')}
              autoFocus
              className="w-full px-3 py-2 text-sm font-mono border border-border rounded-md bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => {
                  setShowAdd(false);
                  setAddPath('');
                }}
                disabled={adding}
                className="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-hover transition-colors disabled:opacity-50"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleAdd}
                disabled={adding || !addPath.trim()}
                className="px-3 py-1.5 text-sm rounded-md bg-brand text-white hover:bg-teal-10 transition-colors disabled:opacity-50"
              >
                {adding ? t('skills.adding') : t('skills.add')}
              </button>
            </div>
          </div>
        </div>
      )}

    </>
  );
}

// ============================================
// Row
// ============================================

interface SkillRowProps {
  skill: SkillInfo;
  selected: boolean;
  onSelect: () => void;
}

/** One list row: icon, `/name`, an invalid badge, and the description's first line. */
function SkillRow({ skill, selected, onSelect }: SkillRowProps) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onSelect}
      className={`rounded-md px-2 py-2 cursor-pointer transition-colors ${
        selected ? 'bg-brand/10' : 'hover:bg-hover'
      } ${skill.valid ? '' : 'opacity-60'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded bg-brand/10 text-brand text-xs">
          {skill.icon ? (
            <span>{skill.icon}</span>
          ) : (
            /* Fallback when SKILL.md declares no emoji. Must match the sidebar's
               Skills entry — a star here would say "favourite", which is what
               that mark means everywhere else in the app. */
            <Joystick className="w-3.5 h-3.5" />
          )}
        </span>
        <span className="font-mono text-xs font-medium text-foreground truncate flex-1 min-w-0">/{skill.name}</span>
        {!skill.valid && (
          <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-red-9/15 text-red-11">
            {t('skills.invalid')}
          </span>
        )}
      </div>
      <div className="text-xs text-muted-foreground truncate mt-0.5 pl-7" data-tooltip={skill.description || undefined}>
        {skill.description || <span className="italic opacity-60">{t('skills.noDescription')}</span>}
      </div>
    </div>
  );
}
