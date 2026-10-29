'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast, MODAL_SHELL_CLASS } from '@cockpit/shared-ui';
import { AppWindow, ExternalLink, FolderOpen, Maximize2, Minimize2, RotateCw, SquareTerminal, Trash2, Plus, X, Search, Copy } from 'lucide-react';
import { publishTopic } from '@cockpit/effect-react';
import { Topics } from '@cockpit/effect-services';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { toExternalBrowserAppUrl, toLocalAppUrl } from '@cockpit/shared-utils';
import { HtmlAppFrame } from '../HtmlAppFrame';
import { DirectoryPane } from '../directory/DirectoryPane';
import { notifyHtmlAppsChanged } from './htmlAppsBus';
import { loadHtmlApps, addHtmlApp, deleteHtmlApp, type HtmlAppInfo } from '@cockpit/shared-api';

export type HtmlAppPreview = { path: string; title: string; icon?: string };

interface HtmlAppsModalProps {
  isOpen: boolean;
  htmlAppPreviews: HtmlAppPreview[];
  activeHtmlAppPreviewPath: string | null;
  onShowHtmlAppPreview: (item: HtmlAppPreview) => void;
  onMinimizeHtmlAppPreview: () => void;
  onCloseHtmlAppPreview: (path: string) => void;
  onClose: () => void;
  onOpenApp?: (path: string) => void;
}

/**
 * HtmlAppsModal — the apps board (sidebar "Apps" entry) plus the full-screen
 * app previews it launches (minimisable to the sidebar dock).
 *
 * Board: registered apps on the left (the user's own, then built-ins), the
 * selected app on the right in two tabs —
 *   - Files (default): its folder as a file tree + source view (DirectoryPane
 *     over /api/html-apps/files), opened on the app's own .html;
 *   - Run: the app itself, live.
 * The board opens on the first app's Files tab. Nothing runs until Run is
 * clicked: previewing an HTML app runs it, with full shell access (see "HTML
 * Apps Runtime" in CLAUDE.md), so neither opening the board nor picking a row
 * executes anything. Leaving the Run tab, picking
 * another app or closing the board unmounts the running one.
 */
export function HtmlAppsModal({
  isOpen,
  htmlAppPreviews,
  activeHtmlAppPreviewPath,
  onShowHtmlAppPreview,
  onMinimizeHtmlAppPreview,
  onCloseHtmlAppPreview,
  onClose,
  onOpenApp,
}: HtmlAppsModalProps) {
  const { t, i18n } = useTranslation();
  const [apps, setApps] = useState<HtmlAppInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [query, setQuery] = useState('');
  const [showAdd, setShowAdd] = useState(false);
  const [addPath, setAddPath] = useState('');
  const [adding, setAdding] = useState(false);
  const [previewReloadKeys, setPreviewReloadKeys] = useState<Record<string, number>>({});
  // The app running in the board's right pane (by id); null = none yet.
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [boardReloadKey, setBoardReloadKey] = useState(0);
  const [rightTab, setRightTab] = useState<'files' | 'run'>('files');
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);

  const reload = useCallback(async () => {
    setLoading(true);
    const exit = await BrowserRuntime.runPromiseExit(loadHtmlApps());
    if (exit._tag === 'Success') setApps(exit.value as HtmlAppInfo[]);
    else console.error('Failed to load html apps', exit.cause);
    setLoading(false);
  }, []);

  useEffect(() => {
    if (isOpen) {
      reload();
      setTimeout(() => {
        searchInputRef.current?.focus();
        searchInputRef.current?.select();
      }, 100);
    }
  }, [isOpen, reload]);

  const handleClose = useCallback(() => {
    setShowAdd(false);
    setSelectedId(null);
    setConfirmDeleteId(null);
    onClose();
  }, [onClose]);

  useEffect(() => {
    if (!isOpen && !activeHtmlAppPreviewPath) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      if (activeHtmlAppPreviewPath) { onCloseHtmlAppPreview(activeHtmlAppPreviewPath); return; }
      if (showAdd) { setShowAdd(false); setAddPath(''); return; }
      handleClose();
    };
    document.addEventListener('keydown', handler);
    return () => document.removeEventListener('keydown', handler);
  }, [isOpen, activeHtmlAppPreviewPath, handleClose, onCloseHtmlAppPreview, showAdd]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return apps;
    return apps.filter(
      (a) =>
        a.name.toLowerCase().includes(q) ||
        a.title.toLowerCase().includes(q) ||
        a.description.toLowerCase().includes(q) ||
        a.path.toLowerCase().includes(q),
    );
  }, [apps, query]);

  const groups = useMemo(() => [
    { key: 'mine', labelKey: 'htmlApps.mine', items: filtered.filter((a) => !a.builtin) },
    { key: 'builtin', labelKey: 'htmlApps.builtin', items: filtered.filter((a) => a.builtin) },
  ].filter((g) => g.items.length > 0), [filtered]);
  const selected = selectedId ? apps.find((a) => a.id === selectedId) ?? null : null;

  // Auto-select the first row so the board opens on an app's files. Safe: the
  // Files tab only reads source — nothing runs until Run is clicked. Only fills
  // a hole (nothing selected, or the selection was deleted).
  const firstId = groups[0]?.items[0]?.id ?? null;
  useEffect(() => {
    if (!isOpen || selected || !firstId) return;
    setSelectedId(firstId);
    setRightTab('files');
  }, [isOpen, selected, firstId]);

  // Built-in cards ship with Cockpit and are always present, so they must not
  // count towards "is this panel empty?" — otherwise the first-run guidance
  // below could never appear again.
  const userAppCount = useMemo(() => apps.filter((a) => !a.builtin).length, [apps]);
  const searching = query.trim().length > 0;
  const showGuidance = !searching && userAppCount === 0;

  const docsUrl = i18n.resolvedLanguage?.startsWith('zh')
    ? 'https://opencockpit.dev/zh/docs/agent/html-apps/'
    : 'https://opencockpit.dev/en/docs/agent/html-apps/';

  const handleAdd = useCallback(async () => {
    const p = addPath.trim();
    if (!p) return;
    setAdding(true);
    const exit = await BrowserRuntime.runPromiseExit(addHtmlApp(p));
    if (exit._tag === 'Success') {
      if (exit.value.alreadyExists) {
        toast(t('htmlApps.alreadyAdded'), 'info');
      } else {
        toast(t('htmlApps.added'), 'success');
        notifyHtmlAppsChanged();
      }
      setAddPath('');
      setShowAdd(false);
      await reload();
    } else {
      const failure = exit.cause._tag === 'Fail' ? exit.cause.error : null;
      const inner = failure?.cause;
      const msg = inner instanceof Error ? inner.message : t('htmlApps.addFailed');
      toast(msg, 'error');
    }
    setAdding(false);
  }, [addPath, reload, t]);

  const handleDelete = useCallback(async (id: string) => {
    const exit = await BrowserRuntime.runPromiseExit(deleteHtmlApp(id));
    if (exit._tag === 'Success') {
      setApps((prev) => prev.filter((a) => a.id !== id));
      setSelectedId((cur) => (cur === id ? null : cur));
      notifyHtmlAppsChanged();
    } else {
      toast(t('common.deleteFailed'), 'error');
    }
  }, [t]);

  // Open in a console browser bubble. Callers outside the project iframe can
  // route the event themselves; in-frame callers keep the original window event.
  const openBubble = useCallback((path: string) => {
    if (onOpenApp) {
      onOpenApp(path);
    } else {
      window.dispatchEvent(new CustomEvent('console-open-browser', { detail: { url: path } }));
    }
    handleClose();
  }, [handleClose, onOpenApp]);

  const openPreviewInConsole = useCallback((path: string) => {
    if (onOpenApp) {
      onOpenApp(path);
    } else {
      window.dispatchEvent(new CustomEvent('console-open-browser', { detail: { url: path } }));
    }
    onMinimizeHtmlAppPreview();
  }, [onMinimizeHtmlAppPreview, onOpenApp]);

  const openExternal = useCallback((path: string) => {
    const appUrl = toLocalAppUrl(path);
    window.open(toExternalBrowserAppUrl(appUrl, window.location.origin), '_blank');
  }, []);

  const refreshPreview = useCallback((path: string) => {
    setPreviewReloadKeys((keys) => ({ ...keys, [path]: (keys[path] || 0) + 1 }));
  }, []);

  const handleCopyPath = useCallback(async (path: string) => {
    try {
      await navigator.clipboard.writeText(path);
      toast(t('common.copiedPath'), 'success');
    } catch {
      toast(t('common.copyFailed'), 'error');
    }
  }, [t]);

  return (
    <>
      {isOpen && (
        <div className="fixed inset-0 z-50 flex items-center justify-center">
          <div className="absolute inset-0 bg-scrim" onClick={handleClose} />
          <div className={MODAL_SHELL_CLASS}>
            <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
              <h2 className="text-sm font-medium text-foreground">{t('htmlApps.title')}</h2>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-foreground-subtle pointer-events-none" />
                  <input
                    ref={searchInputRef}
                    type="text"
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder={t('htmlApps.searchPlaceholder')}
                    className="pl-7 pr-6 py-1 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
                  />
                  {query && (
                    <button
                      onClick={() => { setQuery(''); searchInputRef.current?.focus(); }}
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-foreground-subtle hover:text-foreground rounded-sm transition-colors"
                      title={t('fileBrowser.clear')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <button
                  onClick={() => setShowAdd(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-hover transition-colors"
                  title={t('htmlApps.addHtmlApp')}
                >
                  <Plus className="w-4 h-4" /> {t('htmlApps.add')}
                </button>
                <button onClick={handleClose} className="p-1 text-foreground-subtle hover:text-foreground hover:bg-hover rounded transition-colors" title={t('common.close')}>
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 flex min-h-0">
              {/* Left: apps, grouped. Padding stays off the scroll node so the
                  sticky group header does not leave a strip of rows above it. */}
              <div className="w-full md:w-[300px] min-h-0 flex-shrink-0 md:border-r border-border overflow-y-auto">
                {loading && apps.length === 0 ? (
                  <div className="text-center text-muted-foreground py-8 text-sm">{t('common.loading')}</div>
                ) : (
                  <div className="p-3 space-y-3">
                    {groups.map((group) => (
                      <div key={group.key} className="rounded-lg border border-border">
                        <div className="sticky top-0 z-10 px-3 py-1.5 bg-card rounded-t-lg border-b border-border/60 text-[11px] font-medium text-muted-foreground flex items-center">
                          <span>{t(group.labelKey)}</span>
                          <span className="ml-auto tabular-nums text-foreground-subtle">{group.items.length}</span>
                        </div>
                        <div className="p-1 space-y-0.5">
                          {group.items.map((app) => (
                            <HtmlAppRow
                              key={app.id}
                              app={app}
                              selected={app.id === selectedId}
                              onSelect={() => { setSelectedId(app.id); setConfirmDeleteId(null); setBoardReloadKey(0); setRightTab('files'); }}
                            />
                          ))}
                        </div>
                      </div>
                    ))}

                    {filtered.length === 0 && searching && (
                      <div className="text-center text-muted-foreground py-6 text-xs">{t('htmlApps.emptyNoMatch')}</div>
                    )}

                    {/* Guidance is keyed to *user* apps, so it survives the
                        built-in rows always being present. */}
                    {showGuidance && (
                      <div className="text-center text-muted-foreground py-4 text-xs space-y-2">
                        <p>{t('htmlApps.emptyNoApps')}</p>
                        <p>
                          {t('htmlApps.emptyCreatePrefix')}{' '}
                          <code className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-xs">/html</code>
                          {' '}{t('htmlApps.emptyCreateSuffix')}
                        </p>
                        <p>
                          <button type="button" onClick={() => setShowAdd(true)} className="text-brand hover:underline">
                            {t('htmlApps.addExisting')}
                          </button>
                          {' · '}
                          <a href={docsUrl} target="_blank" rel="noreferrer" className="text-brand hover:underline">
                            {t('htmlApps.viewDocs')}
                          </a>
                        </p>
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Right: the selected app, running */}
              <div className="hidden md:flex flex-1 min-w-0 flex-col">
                {!selected ? (
                  <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground px-6 text-center">
                    {t('htmlApps.selectHint')}
                  </div>
                ) : (() => {
                  const tabButton = (key: 'files' | 'run', label: string) => (
                    <button
                      onClick={() => setRightTab(key)}
                      disabled={key === 'run' && !selected.valid}
                      className={`px-3 py-1 transition-colors disabled:opacity-40 ${
                        rightTab === key ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground hover:bg-hover'
                      }`}
                    >
                      {label}
                    </button>
                  );
                  const controls = (
                    <div className="flex items-center gap-1 flex-shrink-0">
                      <div className="flex items-center rounded-md border border-border overflow-hidden text-xs mr-1">
                        {tabButton('files', t('htmlApps.tabFiles'))}
                        {tabButton('run', t('htmlApps.tabRun'))}
                      </div>
                      {selected.valid && (
                        <>
                          {rightTab === 'run' && (
                            <button onClick={() => setBoardReloadKey((k) => k + 1)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded" data-tooltip={t('common.refresh')} aria-label={t('common.refresh')}>
                              <RotateCw className="w-4 h-4" />
                            </button>
                          )}
                          <button
                            onClick={() => {
                              onShowHtmlAppPreview({ path: selected.path, title: selected.title, icon: selected.icon });
                              handleClose();
                            }}
                            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded"
                            data-tooltip={t('htmlApps.openFull')}
                            aria-label={t('htmlApps.openFull')}
                          >
                            <Maximize2 className="w-4 h-4" />
                          </button>
                          <button onClick={() => openBubble(selected.path)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded" data-tooltip={t('common.openInConsole')} aria-label={t('common.openInConsole')}>
                            <SquareTerminal className="w-4 h-4" />
                          </button>
                          <button onClick={() => openExternal(selected.path)} className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded" data-tooltip={t('browser.openInNewWindow')} aria-label={t('browser.openInNewWindow')}>
                            <ExternalLink className="w-4 h-4" />
                          </button>
                        </>
                      )}
                      {/* Open the app's folder as a project (explorer, git) on its
                          .html — same as the Bots and skills boards. */}
                      <button
                        onClick={() => {
                          const parts = selected.path.split('/');
                          publishTopic(Topics.OpenProject, { cwd: parts.slice(0, -1).join('/'), file: parts[parts.length - 1] });
                          handleClose();
                        }}
                        className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded"
                        data-tooltip={t('common.openAsProject')}
                        aria-label={t('common.openAsProject')}
                      >
                        <FolderOpen className="w-4 h-4" />
                      </button>
                      {/* Built-ins are virtual — there is no html.json entry to remove. */}
                      {selected.builtin ? null : confirmDeleteId === selected.id ? (
                        <div className="flex items-center gap-1">
                          <button onClick={() => { setConfirmDeleteId(null); void handleDelete(selected.id); }} className="px-2 py-1 text-xs rounded bg-red-9 text-white hover:bg-red-10">{t('common.confirm')}</button>
                          <button onClick={() => setConfirmDeleteId(null)} className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground">{t('common.cancel')}</button>
                        </div>
                      ) : (
                        <button onClick={() => setConfirmDeleteId(selected.id)} className="p-1.5 text-muted-foreground hover:text-red-11 hover:bg-red-9/10 rounded" data-tooltip={t('common.delete')} aria-label={t('common.delete')}>
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  );
                  const title = (
                    <span className="flex items-center gap-2 min-w-0">
                      {selected.icon ? <span className="text-base leading-none flex-shrink-0">{selected.icon}</span> : <AppWindow className="w-4 h-4 flex-shrink-0 text-muted-foreground" />}
                      <span className="truncate">{selected.title}</span>
                    </span>
                  );

                  if (rightTab === 'files') {
                    return (
                      <DirectoryPane
                        // Remount per app: listing, picked file and mode reset.
                        key={selected.id}
                        endpoint="/api/html-apps/files"
                        id={selected.id}
                        entryFile={selected.path.split('/').pop() || 'index.html'}
                        title={title}
                        actions={controls}
                      />
                    );
                  }

                  return (
                    <>
                      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
                        <div className="flex-1 min-w-0">
                          <h2 className="text-sm font-medium text-foreground truncate">{title}</h2>
                          <div className="flex items-center gap-1 min-w-0 mt-0.5">
                            <span className="font-mono text-xs text-muted-foreground truncate" data-tooltip={selected.path}>{selected.path}</span>
                            <button onClick={() => handleCopyPath(selected.path)} className="p-0.5 text-muted-foreground hover:text-foreground hover:bg-hover rounded flex-shrink-0" title={t('common.copyPath')} aria-label={t('common.copyPath')}>
                              <Copy className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                        {controls}
                      </div>
                      <div className="flex-1 min-h-0 overflow-hidden">
                        {/* Remount per app; unmounted on leaving this tab.
                            User clicked Run → trusted (gets the bash SDK). */}
                        <HtmlAppFrame key={selected.id} filePath={selected.path} reloadKey={boardReloadKey} />
                      </div>
                    </>
                  );
                })()}
              </div>
            </div>
          </div>
        </div>
      )}

      {isOpen && showAdd && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-scrim" onClick={() => { if (!adding) { setShowAdd(false); setAddPath(''); } }} />
          <div className="relative bg-card rounded-lg shadow-lv3 w-full max-w-lg mx-4 p-5">
            <h3 className="text-sm font-medium text-foreground mb-3">{t('htmlApps.addHtmlApp')}</h3>
            <label className="block text-xs text-muted-foreground mb-1">{t('htmlApps.pathLabel')}</label>
            <input
              type="text"
              value={addPath}
              onChange={(e) => setAddPath(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !adding) handleAdd(); }}
              placeholder="/Users/you/.../report.html"
              autoFocus
              className="w-full px-3 py-2 text-sm font-mono border border-border rounded-md bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <div className="flex justify-end gap-2 mt-4">
              <button
                onClick={() => { setShowAdd(false); setAddPath(''); }}
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
                {adding ? t('htmlApps.adding') : t('htmlApps.add')}
              </button>
            </div>
          </div>
        </div>
      )}

      {htmlAppPreviews.map((item) => {
        const visible = activeHtmlAppPreviewPath === item.path;
        // bg-scrim matches every other dialog backdrop in the app
        // (SessionBrowser, this file's own panel, HtmlPreviewModal). Clicking
        // it minimises rather than closes — the preview stays available as a
        // dock pill, which is the pre-existing behaviour.
        return (
          <div
            key={item.path}
            className={visible ? 'fixed inset-0 z-[60] flex items-center justify-center bg-scrim p-0 md:p-4' : 'hidden'}
            onClick={onMinimizeHtmlAppPreview}
          >
            {/* The app frame paints the app's own background, which can
                sit flush against the dimmed backdrop and blur the window edge.
                A brand outline marks it, kept just under full strength so it
                reads as a boundary rather than a highlighted/selected state.

                A faint brand border over the stock depth shadow is enough —
                the backdrop already separates the window from the page. */}
            <div className="bg-card shadow-lv3 border border-brand/30 w-full h-full md:max-w-[90%] md:h-[90vh] md:rounded-lg flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border flex-shrink-0">
                {/* Same icon treatment as the minimised dock pill, so an app
                    looks the same collapsed and expanded. */}
                <div className="flex items-center gap-2 min-w-0 flex-1">
                  {item.icon
                    ? <span className="text-base leading-none flex-shrink-0">{item.icon}</span>
                    : <AppWindow className="w-4 h-4 flex-shrink-0" />}
                  <span className="text-sm text-muted-foreground truncate max-w-[35%]" data-tooltip={item.title}>{item.title}</span>
                  <span className="text-sm text-muted-foreground flex-shrink-0" aria-hidden="true">-</span>
                  <span className="font-mono text-sm text-muted-foreground truncate min-w-0" data-tooltip={item.path}>{item.path}</span>
                  <button
                    onClick={() => handleCopyPath(item.path)}
                    className="text-muted-foreground hover:text-foreground p-0.5 rounded hover:bg-hover transition-colors flex-shrink-0"
                    title={t('common.copyPath')}
                    aria-label={t('common.copyPath')}
                  >
                    <Copy className="w-4 h-4" />
                  </button>
                </div>
                <button onClick={onMinimizeHtmlAppPreview} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors flex-shrink-0" title={t('common.minimize')}>
                  <Minimize2 className="w-4 h-4" />
                </button>
                <button onClick={() => openPreviewInConsole(item.path)} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors flex-shrink-0" title={t('common.openInConsole')}>
                  <SquareTerminal className="w-4 h-4" />
                </button>
                <button onClick={() => openExternal(item.path)} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors flex-shrink-0" title={t('browser.openInNewWindow')}>
                  <ExternalLink className="w-4 h-4" />
                </button>
                <button onClick={() => refreshPreview(item.path)} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors flex-shrink-0" title={t('common.refresh')}>
                  <RotateCw className="w-4 h-4" />
                </button>
                <button onClick={() => onCloseHtmlAppPreview(item.path)} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-hover transition-colors flex-shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                {/* User opened this app → trusted (gets the bash SDK). */}
                <HtmlAppFrame filePath={item.path} reloadKey={previewReloadKeys[item.path] || 0} />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

interface HtmlAppRowProps {
  app: HtmlAppInfo;
  selected: boolean;
  onSelect: () => void;
}

/** One list row: icon, title, `/name`, badges, the description's first line. */
function HtmlAppRow({ app, selected, onSelect }: HtmlAppRowProps) {
  const { t } = useTranslation();
  return (
    <div
      onClick={onSelect}
      className={`rounded-md px-2 py-2 cursor-pointer transition-colors ${selected ? 'bg-brand/10' : 'hover:bg-hover'} ${app.valid ? '' : 'opacity-60'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="w-5 h-5 flex-shrink-0 flex items-center justify-center rounded bg-brand/10 text-brand text-xs">
          {app.icon ? <span>{app.icon}</span> : <AppWindow className="w-3.5 h-3.5" />}
        </span>
        <span className="text-xs font-medium text-foreground truncate min-w-0" data-tooltip={app.title}>{app.title}</span>
        <span className="font-mono text-[10px] text-muted-foreground truncate flex-1 min-w-0" data-tooltip={app.path}>/{app.name}</span>
        {!app.valid && <span className="flex-shrink-0 text-[10px] px-1.5 py-0.5 rounded bg-red-9/15 text-red-11">{t('htmlApps.invalid')}</span>}
      </div>
      <div className="text-xs text-muted-foreground truncate mt-0.5 pl-7" data-tooltip={app.description || undefined}>
        {app.description || <span className="italic opacity-60">{t('htmlApps.noDescription')}</span>}
      </div>
    </div>
  );
}
