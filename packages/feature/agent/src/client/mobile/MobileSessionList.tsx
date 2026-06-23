'use client';

import { useState, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { Pin, Bell, BellOff } from 'lucide-react';
import { useWebSocket } from '@cockpit/shared-ui';
import { usePinnedSessions } from '../usePinnedSessions';
import { usePushSubscription } from '../usePushSubscription';
import type { GlobalSession } from '../GlobalSessionMonitor';

// What the list needs to open a session — satisfied by both a recent
// GlobalSession and a pinned session.
export interface OpenableSession {
  cwd: string;
  sessionId: string;
  title?: string;
}

// Touch-friendly session list for /m, with two entries:
//   - Recent: the realtime /ws/global-state feed (cross-project, sorted, top 15).
//   - Pinned: user's "常用会话" (/api/pinned-sessions via usePinnedSessions).
interface MobileSessionListProps {
  onOpen: (session: OpenableSession) => void;
  onUseDesktop: () => void;
}

type Tab = 'recent' | 'pinned';

export function MobileSessionList({ onOpen, onUseDesktop }: MobileSessionListProps) {
  const { t } = useTranslation();
  const [tab, setTab] = useState<Tab>('recent');
  const [sessions, setSessions] = useState<GlobalSession[]>([]);
  const [now, setNow] = useState(() => Date.now());
  const { pinnedSessions } = usePinnedSessions();
  const { supported: pushSupported, isSubscribed, busy: pushBusy, subscribe, unsubscribe } = usePushSubscription();

  const handleMessage = useCallback((msg: unknown) => {
    const parsed = msg as { type?: string; data?: { sessions?: GlobalSession[] } };
    if (parsed.type === 'task-fired') return;
    if (!parsed.data) return;
    setSessions(parsed.data.sessions || []);
    setNow(Date.now());
  }, []);

  useWebSocket({ url: '/ws/global-state', onMessage: handleMessage });

  const formatTime = useCallback((timestamp: number) => {
    const minutes = Math.floor((now - timestamp) / 60000);
    if (minutes < 1) return t('common.justNow');
    if (minutes < 60) return t('common.minutesAgo', { count: minutes });
    const hours = Math.floor(minutes / 60);
    if (hours < 24) return t('common.hoursAgo', { count: hours });
    return t('common.daysAgo', { count: Math.floor(hours / 24) });
  }, [now, t]);

  const projectName = (cwd: string) => cwd.split('/').pop() || cwd;
  const loadingCount = sessions.filter((s) => s.status === 'loading').length;

  const tabBtn = (key: Tab, label: string) => (
    <button
      type="button"
      onClick={() => setTab(key)}
      className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
        tab === key ? 'bg-card text-foreground shadow-sm' : 'text-muted-foreground'
      }`}
    >
      {label}
    </button>
  );

  return (
    <div className="flex h-[100dvh] flex-col bg-card">
      {/* Header: tab switch + desktop escape hatch */}
      <div className="flex flex-shrink-0 items-center gap-3 border-b border-border px-3 py-2.5 pt-[max(0.625rem,env(safe-area-inset-top))]">
        <div className="flex flex-1 items-center gap-1 rounded-lg bg-accent p-0.5">
          {tabBtn('recent', t('sessions.recentSessions'))}
          {tabBtn('pinned', t('sessions.pinnedSessions'))}
        </div>
        {pushSupported && (
          <button
            type="button"
            onClick={isSubscribed ? unsubscribe : subscribe}
            disabled={pushBusy}
            aria-label={isSubscribed
              ? t('mobile.disableNotifications', { defaultValue: 'Disable notifications' })
              : t('mobile.enableNotifications', { defaultValue: 'Enable notifications' })}
            className={`flex h-8 w-8 flex-shrink-0 items-center justify-center rounded-lg active:bg-accent disabled:opacity-40 ${
              isSubscribed ? 'text-brand' : 'text-muted-foreground'
            }`}
          >
            {isSubscribed ? <Bell className="h-4 w-4" /> : <BellOff className="h-4 w-4" />}
          </button>
        )}
        <button
          type="button"
          onClick={onUseDesktop}
          className="flex-shrink-0 rounded-lg px-2 py-1 text-xs text-muted-foreground active:bg-accent"
        >
          {t('mobile.useDesktop')}
        </button>
      </div>

      {/* Running count (recent tab only) */}
      {tab === 'recent' && loadingCount > 0 && (
        <div className="flex-shrink-0 border-b border-border/50 px-4 py-1.5 text-xs text-orange-11">
          {t('sessions.runningCount', { count: loadingCount })}
        </div>
      )}

      {/* List */}
      <div className="min-h-0 flex-1 overflow-y-auto">
        {tab === 'recent' ? (
          sessions.length === 0 ? (
            <Empty text={t('sessions.noSessions')} />
          ) : (
            sessions.map((session) => (
              <button
                key={`${session.cwd}-${session.sessionId}`}
                onClick={() => onOpen({ cwd: session.cwd, sessionId: session.sessionId, title: session.title })}
                className="flex w-full items-start gap-3 border-b border-border/50 px-4 py-3.5 text-left active:bg-accent"
              >
                <span
                  className={`mt-1.5 h-2.5 w-2.5 flex-shrink-0 rounded-full ${
                    session.status === 'loading'
                      ? 'animate-pulse bg-orange-9'
                      : session.status === 'unread'
                        ? 'bg-red-500'
                        : 'bg-muted-foreground/30'
                  }`}
                />
                <div className="min-w-0 flex-1">
                  <div className="flex items-center gap-2">
                    <span className="truncate text-sm font-medium">{projectName(session.cwd)}</span>
                    {session.status === 'loading' && (
                      <span className="flex-shrink-0 text-xs text-orange-11">{t('sessions.running')}</span>
                    )}
                    {session.status === 'unread' && (
                      <span className="flex-shrink-0 text-xs text-red-500">{t('sessions.done')}</span>
                    )}
                    <span className="ml-auto flex-shrink-0 text-xs text-muted-foreground">
                      {formatTime(session.lastActive)}
                    </span>
                  </div>
                  {(session.lastUserMessage || session.title) && (
                    <div className="mt-0.5 truncate text-xs text-foreground/70">
                      {session.lastUserMessage || session.title}
                    </div>
                  )}
                </div>
              </button>
            ))
          )
        ) : pinnedSessions.length === 0 ? (
          <Empty text={t('sessions.noPinnedSessions')} />
        ) : (
          pinnedSessions.map((p) => (
            <button
              key={`${p.cwd}-${p.sessionId}`}
              onClick={() => onOpen({ cwd: p.cwd, sessionId: p.sessionId, title: p.customTitle })}
              className="flex w-full items-start gap-3 border-b border-border/50 px-4 py-3.5 text-left active:bg-accent"
            >
              <Pin className="mt-0.5 h-4 w-4 flex-shrink-0 text-brand" />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-medium">{p.customTitle || projectName(p.cwd)}</div>
                <div className="truncate text-xs text-muted-foreground">{projectName(p.cwd)}</div>
              </div>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

function Empty({ text }: { text: string }) {
  return <div className="px-4 py-8 text-center text-sm text-muted-foreground">{text}</div>;
}
