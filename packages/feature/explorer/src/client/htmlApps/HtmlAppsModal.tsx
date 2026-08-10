'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { ExternalLink, Minimize2, SquareTerminal, Trash2, Plus, X, Search, Copy } from 'lucide-react';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { HtmlPreview } from '../HtmlPreview';
import { notifyHtmlAppsChanged } from './htmlAppsBus';
import { loadHtmlApps, addHtmlApp, deleteHtmlApp, type HtmlAppInfo } from './htmlAppsClient';

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
          <div className="absolute inset-0 bg-black/50" onClick={handleClose} />
          <div className="relative bg-card rounded-lg shadow-xl w-full max-w-7xl h-[90vh] mx-4 flex flex-col overflow-hidden">
            <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
              <h2 className="text-sm font-medium text-foreground">{t('htmlApps.title')}</h2>
              <div className="flex items-center gap-3">
                <div className="relative">
                  <Search className="absolute left-2 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-9 pointer-events-none" />
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
                      className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-slate-9 hover:text-foreground rounded-sm transition-colors"
                      title={t('fileBrowser.clear')}
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>
                <button
                  onClick={() => setShowAdd(true)}
                  className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                  title={t('htmlApps.addHtmlApp')}
                >
                  <Plus className="w-4 h-4" /> {t('htmlApps.add')}
                </button>
                <button onClick={handleClose} className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors" title={t('common.close')}>
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="flex-1 overflow-y-auto p-4">
              {loading ? (
                <div className="text-center text-muted-foreground py-8 text-sm">{t('common.loading')}</div>
              ) : filtered.length === 0 ? (
                <div className="text-center text-muted-foreground py-8 text-sm space-y-2">
                  {apps.length === 0 ? (
                    <>
                      <p>{t('htmlApps.emptyNoApps')}</p>
                      <p>
                        {t('htmlApps.emptyCreatePrefix')}{' '}
                        <code className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-xs">/html</code>
                        {' '}{t('htmlApps.emptyCreateSuffix')}
                      </p>
                      <p>
                        <button
                          type="button"
                          onClick={() => setShowAdd(true)}
                          className="text-brand hover:underline"
                        >
                          {t('htmlApps.addExisting')}
                        </button>
                        {' · '}
                        <a
                          href={docsUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="text-brand hover:underline"
                        >
                          {t('htmlApps.viewDocs')}
                        </a>
                      </p>
                    </>
                  ) : t('htmlApps.emptyNoMatch')}
                </div>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                  {filtered.map((app) => (
                    <HtmlAppCard
                      key={app.id}
                      app={app}
                      onOpenConsole={() => openBubble(app.path)}
                      onPreview={() => {
                        onShowHtmlAppPreview({ path: app.path, title: app.title, icon: app.icon });
                        handleClose();
                      }}
                      onDelete={() => handleDelete(app.id)}
                      onCopyPath={() => handleCopyPath(app.path)}
                    />
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {isOpen && showAdd && (
        <div className="fixed inset-0 z-[60] flex items-center justify-center">
          <div className="absolute inset-0 bg-black/50" onClick={() => { if (!adding) { setShowAdd(false); setAddPath(''); } }} />
          <div className="relative bg-card rounded-lg shadow-xl w-full max-w-lg mx-4 p-5">
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
                className="px-3 py-1.5 text-sm rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
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
        return (
          <div
            key={item.path}
            className={visible ? 'fixed inset-0 z-[60] flex items-center justify-center p-0 md:p-4' : 'hidden'}
            onClick={onMinimizeHtmlAppPreview}
          >
            <div className="bg-card shadow-xl w-full h-full md:max-w-[90%] md:h-[90vh] md:rounded-lg flex flex-col overflow-hidden" onClick={(e) => e.stopPropagation()}>
              <div className="flex items-center justify-between gap-3 px-4 py-2 border-b border-border flex-shrink-0">
                <span className="text-sm text-muted-foreground truncate min-w-0 flex-1" data-tooltip={item.path}>{item.title}</span>
                <button onClick={onMinimizeHtmlAppPreview} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors flex-shrink-0" title={t('common.minimize')}>
                  <Minimize2 className="w-4 h-4" />
                </button>
                <button onClick={() => onCloseHtmlAppPreview(item.path)} className="text-muted-foreground hover:text-foreground px-1.5 py-0.5 rounded hover:bg-accent transition-colors flex-shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex-1 overflow-hidden">
                {/* User opened this app → trusted (gets the bash SDK). */}
                <HtmlPreview filePath={item.path} />
              </div>
            </div>
          </div>
        );
      })}
    </>
  );
}

interface HtmlAppCardProps {
  app: HtmlAppInfo;
  onOpenConsole: () => void;
  onPreview: () => void;
  onDelete: () => void;
  onCopyPath: () => void;
}

function HtmlAppCard({ app, onOpenConsole, onPreview, onDelete, onCopyPath }: HtmlAppCardProps) {
  const { t } = useTranslation();
  const [confirmDel, setConfirmDel] = useState(false);

  return (
    <div
      className={`group flex flex-col h-full border border-border rounded-lg p-3 bg-secondary hover:border-brand hover:shadow-md transition-all cursor-pointer ${app.valid ? '' : 'opacity-60'}`}
      onClick={() => app.valid && onPreview()}
    >
      <div className="flex items-center gap-2.5">
        <div className="w-9 h-9 flex-shrink-0 flex items-center justify-center rounded-md bg-brand/10 text-brand text-lg">
          {app.icon ? <span>{app.icon}</span> : <ExternalLink className="w-5 h-5" />}
        </div>
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-foreground truncate" data-tooltip={app.title}>{app.title}</div>
          <div className="font-mono text-[11px] text-muted-foreground truncate" data-tooltip={`/${app.name}`}>/{app.name}</div>
        </div>
        {!app.valid && <span className="flex-shrink-0 text-xs px-1.5 py-0.5 rounded bg-red-9/15 text-red-11">{t('htmlApps.invalid')}</span>}
        <div className="flex items-center gap-1 flex-shrink-0 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onOpenConsole}
            disabled={!app.valid}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
            title={t('common.openInConsole')}
          >
            <SquareTerminal className="w-4 h-4" />
          </button>
          {confirmDel ? (
            <>
              <button onClick={() => { setConfirmDel(false); onDelete(); }} className="px-2 py-1 text-xs rounded bg-red-9 text-white hover:bg-red-10">{t('common.confirm')}</button>
              <button onClick={() => setConfirmDel(false)} className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground">{t('common.cancel')}</button>
            </>
          ) : (
            <button onClick={() => setConfirmDel(true)} className="p-1.5 text-muted-foreground hover:text-red-11 hover:bg-red-9/10 rounded transition-colors" title={t('common.delete')}>
              <Trash2 className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      <div className="font-mono text-xs text-muted-foreground mt-2 break-all">
        {app.path}
        <button onClick={(e) => { e.stopPropagation(); onCopyPath(); }} className="inline-flex align-middle ml-1 p-0.5 hover:text-foreground hover:bg-accent rounded transition-colors" title={t('common.copyPath')}>
          <Copy className="w-3.5 h-3.5" />
        </button>
      </div>

      <p className="text-sm text-muted-foreground mt-2 pt-2 border-t border-border/60 break-words whitespace-pre-wrap">
        {app.description || <span className="italic opacity-60">{t('htmlApps.noDescription')}</span>}
      </p>
    </div>
  );
}
