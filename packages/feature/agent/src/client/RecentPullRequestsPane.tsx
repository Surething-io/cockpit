'use client';

import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import type { RecentSessionInfo } from './effect/agentClient';
import type { SessionPullRequest } from '../shared/sessionDto';
import { matchesPullRequestQuery, parsePullRequestQuery } from '../shared/pullRequests';
import { EngineBadge } from './EngineBadge';
import { SessionNumberBadge } from './SessionNumberBadge';
import { SessionTranscriptPreview } from './SessionTranscriptPreview';
import { buildResumeCommand } from './resumeCommand';
import { projectNameOf } from './SessionRowParts';
import type { ChatEngine } from './types';

/**
 * The recent-sessions board's "PR" tab: every pull request the board's sessions
 * opened (`gh pr create`, extracted by the transcript index), newest first, and
 * the selected PR's session transcript on the right.
 *
 * Scope is the board's own list — sessions active within the last week, at most
 * 100 — so the two tabs always agree on which sessions exist. A PR is one row
 * even when several sessions printed it (one opened it, a later one pushed
 * review fixes); those sessions expand under the row.
 */

interface PullRequestLink {
  /** `${url}\n${cwd}\n${sessionId}` — selection identity. */
  key: string;
  session: RecentSessionInfo;
  pr: SessionPullRequest;
}

interface PullRequestRow {
  url: string;
  repo: string;
  number: number;
  title: string;
  /** Epoch ms of the opening session's result line (falls back to its activity). */
  createdAt: number;
  /** Opener first. */
  links: PullRequestLink[];
}

type DateGroup = 'dateToday' | 'dateYesterday' | 'dateLast7Days' | 'dateEarlier';

const createdAtOf = (link: PullRequestLink): number => {
  const ts = link.pr.createdAt ? Date.parse(link.pr.createdAt) : NaN;
  return Number.isNaN(ts) ? link.session.lastActive : ts;
};

function dateGroupOf(ts: number, now: Date): DateGroup {
  const startOfToday = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const day = 24 * 60 * 60 * 1000;
  if (ts >= startOfToday) return 'dateToday';
  if (ts >= startOfToday - day) return 'dateYesterday';
  if (ts >= startOfToday - 6 * day) return 'dateLast7Days';
  return 'dateEarlier';
}

const formatClock = (ts: number, now: Date): string => {
  const d = new Date(ts);
  const pad = (n: number) => String(n).padStart(2, '0');
  const time = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return d.toDateString() === now.toDateString() ? time : `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${time}`;
};

const repoNameOf = (repo: string) => repo.split('/').pop() || repo;

export function buildPullRequestRows(
  sessions: readonly RecentSessionInfo[],
  titleOf: (session: RecentSessionInfo) => string,
): PullRequestRow[] {
  const byUrl = new Map<string, PullRequestLink[]>();
  for (const session of sessions) {
    for (const pr of session.pullRequests ?? []) {
      const link = { key: `${pr.url}\n${session.cwd}\n${session.sessionId}`, session, pr };
      const links = byUrl.get(pr.url);
      if (links) links.push(link);
      else byUrl.set(pr.url, [link]);
    }
  }
  const rows: PullRequestRow[] = [];
  for (const [url, links] of byUrl) {
    links.sort((a, b) => createdAtOf(a) - createdAtOf(b));
    const opener = links[0];
    rows.push({
      url,
      repo: opener.pr.repo,
      number: opener.pr.number,
      title: links.find((l) => l.pr.title)?.pr.title ?? titleOf(opener.session),
      createdAt: createdAtOf(opener),
      links,
    });
  }
  return rows.sort((a, b) => b.createdAt - a.createdAt);
}

interface RecentPullRequestsPaneProps {
  /** The board's merged session list (fetched + live). */
  sessions: readonly RecentSessionInfo[];
  isLoading: boolean;
  error: string | null;
  sessionNumbers: Record<string, string>;
  titleOf: (session: RecentSessionInfo) => string;
  onOpenSession: (session: RecentSessionInfo) => void;
}

export function RecentPullRequestsPane({ sessions, isLoading, error, sessionNumbers, titleOf, onOpenSession }: RecentPullRequestsPaneProps) {
  const { t } = useTranslation();
  const [searchKeyword, setSearchKeyword] = useState('');
  const [repoFilter, setRepoFilter] = useState('');
  const [engineFilter, setEngineFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(() => new Set());
  const searchInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const timer = setTimeout(() => searchInputRef.current?.focus(), 0);
    return () => clearTimeout(timer);
  }, []);

  const rows = useMemo(() => buildPullRequestRows(sessions, titleOf), [sessions, titleOf]);
  const repos = useMemo(() => [...new Set(rows.map((r) => r.repo))].sort(), [rows]);
  const engines = useMemo(
    () => [...new Set(rows.flatMap((r) => r.links.map((l) => l.session.engine || 'claude')))].sort(),
    [rows],
  );

  const filteredRows = useMemo(() => {
    const query = parsePullRequestQuery(searchKeyword);
    const keyword = searchKeyword.trim().toLowerCase();
    return rows.filter((row) => {
      if (repoFilter && row.repo !== repoFilter) return false;
      if (engineFilter && !row.links.some((l) => (l.session.engine || 'claude') === engineFilter)) return false;
      if (!keyword) return true;
      if (query) return matchesPullRequestQuery(row, query);
      return (
        row.title.toLowerCase().includes(keyword) ||
        row.repo.toLowerCase().includes(keyword) ||
        row.links.some((l) => titleOf(l.session).toLowerCase().includes(keyword))
      );
    });
  }, [rows, searchKeyword, repoFilter, engineFilter, titleOf]);

  // Keyboard order: each row's opener, plus its other sessions when expanded.
  const visibleLinks = useMemo(
    () => filteredRows.flatMap((row) => (expanded.has(row.url) ? row.links : [row.links[0]])),
    [filteredRows, expanded],
  );

  const selected = useMemo(() => {
    const row = filteredRows.find((r) => r.links.some((l) => l.key === selectedKey));
    const link = row?.links.find((l) => l.key === selectedKey);
    return row && link ? { row, link } : null;
  }, [filteredRows, selectedKey]);

  // Fill a missing selection with the first visible row; never steal one the user made.
  useEffect(() => {
    if (selected) return;
    setSelectedKey(visibleLinks[0]?.key ?? null);
  }, [selected, visibleLinks]);

  const openPullRequest = useCallback((url: string) => {
    window.open(url, '_blank', 'noopener,noreferrer');
  }, []);

  const toggleExpanded = useCallback((url: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(url)) next.delete(url);
      else next.add(url);
      return next;
    });
  }, []);

  const onSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (visibleLinks.length === 0) return;
      const at = visibleLinks.findIndex((l) => l.key === selectedKey);
      const next = e.key === 'ArrowDown'
        ? Math.min(visibleLinks.length - 1, at + 1)
        : Math.max(0, at - 1);
      setSelectedKey(visibleLinks[next].key);
    } else if (e.key === 'Enter' && selected && !e.nativeEvent.isComposing) {
      e.preventDefault();
      if (e.metaKey || e.ctrlKey) openPullRequest(selected.row.url);
      else onOpenSession(selected.link.session);
    }
  };

  const listBody = () => {
    if (sessions.length === 0 && isLoading) {
      return <div className="text-xs text-muted-foreground text-center py-6">{t('sessions.loadingSessions')}</div>;
    }
    if (sessions.length === 0 && error) {
      return <div className="text-xs text-red-11 text-center py-6">{error}</div>;
    }
    if (rows.length === 0) {
      return (
        <div className="text-xs text-muted-foreground text-center py-6 space-y-1">
          <div>{t('sessions.noPullRequests')}</div>
          <div className="text-foreground-subtle">{t('sessions.noPullRequestsHint')}</div>
        </div>
      );
    }
    if (filteredRows.length === 0) {
      return <div className="text-xs text-muted-foreground text-center py-6">{t('sessions.noMatchingPullRequests')}</div>;
    }
    const now = new Date();
    const groups: Array<{ group: DateGroup; rows: PullRequestRow[] }> = [];
    for (const row of filteredRows) {
      const group = dateGroupOf(row.createdAt, now);
      const last = groups[groups.length - 1];
      if (last?.group === group) last.rows.push(row);
      else groups.push({ group, rows: [row] });
    }
    return groups.map(({ group, rows: groupRows }) => (
      <div key={group}>
        <div className="sticky top-0 z-10 bg-card px-3 py-1 text-[11px] font-medium text-muted-foreground">
          {t(`sessions.${group}`)}
        </div>
        <div className="space-y-0.5">
          {groupRows.map((row) => (
            <PullRequestRowItem
              key={row.url}
              row={row}
              selectedKey={row.links.some((l) => l.key === selectedKey) ? selectedKey : null}
              isExpanded={expanded.has(row.url)}
              clock={formatClock(row.createdAt, now)}
              sessionNumbers={sessionNumbers}
              titleOf={titleOf}
              onSelect={setSelectedKey}
              onOpenSession={onOpenSession}
              onToggleExpanded={toggleExpanded}
            />
          ))}
        </div>
      </div>
    ));
  };

  return (
    <>
      <div className="w-full md:w-[360px] min-h-0 flex-shrink-0 md:border-r border-border flex flex-col">
        <div className="p-3 flex-shrink-0 border-b border-border space-y-2">
          <div className="relative">
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('sessions.searchPullRequests')}
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              onKeyDown={onSearchKeyDown}
              className="w-full px-2 py-1 pr-6 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
            {searchKeyword && (
              <button
                onClick={() => {
                  setSearchKeyword('');
                  searchInputRef.current?.focus();
                }}
                className="absolute right-1 top-1/2 -translate-y-1/2 p-0.5 text-foreground-subtle hover:text-foreground rounded-sm transition-colors"
                title={t('fileBrowser.clear')}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            )}
          </div>
          <div className="flex gap-2">
            <FilterDropdown
              className="flex-1 min-w-0"
              value={repoFilter}
              allLabel={t('sessions.allRepos')}
              options={repos}
              onChange={setRepoFilter}
            />
            <FilterDropdown
              className="w-28"
              value={engineFilter}
              allLabel={t('sessions.allEngines')}
              options={engines}
              onChange={setEngineFilter}
            />
          </div>
        </div>
        <div className="flex-1 min-h-0 overflow-y-auto">
          <div className="p-2 space-y-2">{listBody()}</div>
        </div>
      </div>

      <div className="hidden md:flex flex-1 min-w-0 flex-col">
        {selected ? (
          <>
            <PullRequestHeader
              row={selected.row}
              link={selected.link}
              onOpenSession={onOpenSession}
              onOpenPullRequest={openPullRequest}
            />
            <div className="flex-1 min-h-0 flex">
              <SessionTranscriptPreview
                key={`${selected.link.session.cwd}\n${selected.link.session.sessionId}`}
                cwd={selected.link.session.cwd}
                sessionId={selected.link.session.sessionId}
                subtitle={titleOf(selected.link.session)}
                emptyText={t('sessions.noSessionMessages')}
                onOpenSession={() => onOpenSession(selected.link.session)}
              />
            </div>
          </>
        ) : (
          <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
            {t('sessions.selectPullRequestHint')}
          </div>
        )}
      </div>
    </>
  );
}

interface PullRequestRowItemProps {
  row: PullRequestRow;
  /** The selected link key when it belongs to this row, else null — keeps memo hits. */
  selectedKey: string | null;
  isExpanded: boolean;
  clock: string;
  sessionNumbers: Record<string, string>;
  titleOf: (session: RecentSessionInfo) => string;
  onSelect: (key: string) => void;
  onOpenSession: (session: RecentSessionInfo) => void;
  onToggleExpanded: (url: string) => void;
}

const PullRequestRowItem = memo(function PullRequestRowItem({
  row, selectedKey, isExpanded, clock, sessionNumbers, titleOf, onSelect, onOpenSession, onToggleExpanded,
}: PullRequestRowItemProps) {
  const { t } = useTranslation();
  const opener = row.links[0];
  const numberOf = (link: PullRequestLink) => sessionNumbers[`${link.session.cwd}\n${link.session.sessionId}`];
  return (
    <div className={`rounded-md ${selectedKey ? 'bg-brand/10' : ''}`}>
      <div
        onClick={() => onSelect(opener.key)}
        onDoubleClick={() => onOpenSession(opener.session)}
        className={`px-3 py-2 rounded-md cursor-pointer transition-colors ${selectedKey ? '' : 'hover:bg-hover'}`}
      >
        <div className="flex items-center gap-1.5">
          <span className="text-xs font-medium text-foreground truncate" data-tooltip={row.url}>
            {repoNameOf(row.repo)}#{row.number}
          </span>
          <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0 tabular-nums">{clock}</span>
        </div>
        <div className="text-xs text-foreground truncate mt-0.5" data-tooltip={row.title}>{row.title}</div>
        <div className="flex items-center gap-1.5 mt-1">
          <EngineBadge engine={opener.session.engine} size="sm" />
          <span className="text-[11px] text-muted-foreground truncate" data-tooltip={opener.session.cwd}>
            {projectNameOf(opener.session.cwd)}
          </span>
          <SessionNumberBadge coordinate={numberOf(opener)} bot={opener.session.bot} />
          {row.links.length > 1 && (
            <button
              onClick={(e) => {
                e.stopPropagation();
                onToggleExpanded(row.url);
              }}
              className="ml-auto text-[11px] text-muted-foreground hover:text-foreground flex-shrink-0"
            >
              {isExpanded ? '▾' : '▸'} {t('sessions.pullRequestSessions', { count: row.links.length })}
            </button>
          )}
        </div>
      </div>
      {isExpanded && row.links.length > 1 && (
        <div className="pb-1">
          {row.links.map((link, i) => (
            <div
              key={link.key}
              onClick={() => onSelect(link.key)}
              onDoubleClick={() => onOpenSession(link.session)}
              className={`flex items-center gap-1.5 ml-6 mr-2 px-2 py-1 rounded text-[11px] cursor-pointer ${
                link.key === selectedKey ? 'bg-brand/15 text-foreground' : 'text-muted-foreground hover:bg-hover'
              }`}
            >
              <span className="text-foreground-subtle">{i === row.links.length - 1 ? '└' : '├'}</span>
              <span className="truncate flex-1" data-tooltip={titleOf(link.session)}>{titleOf(link.session)}</span>
              <SessionNumberBadge coordinate={numberOf(link)} bot={link.session.bot} />
            </div>
          ))}
        </div>
      )}
    </div>
  );
});

function PullRequestHeader({ row, link, onOpenSession, onOpenPullRequest }: {
  row: PullRequestRow;
  link: PullRequestLink;
  onOpenSession: (session: RecentSessionInfo) => void;
  onOpenPullRequest: (url: string) => void;
}) {
  const { t } = useTranslation();
  const resumeCommand = buildResumeCommand(link.session.engine as ChatEngine | undefined, link.session.sessionId);
  const buttonClass = 'px-2.5 py-1 text-xs rounded border border-border text-foreground hover:bg-hover transition-colors';
  return (
    <div className="px-4 py-2.5 border-b border-border flex-shrink-0 space-y-1.5">
      <div className="flex items-center gap-2 min-w-0">
        <span className="text-sm font-medium text-foreground truncate" data-tooltip={row.title}>{row.title}</span>
        <span className="ml-auto flex-shrink-0"><EngineBadge engine={link.session.engine} /></span>
      </div>
      <div className="text-[11px] text-muted-foreground truncate" data-tooltip={row.url}>
        {row.repo}#{row.number}
      </div>
      <div className="flex items-center gap-2">
        <button onClick={() => onOpenSession(link.session)} className={buttonClass} title="↩">
          {t('scheduledTasks.openSession')}
        </button>
        <button
          onClick={() => {
            navigator.clipboard.writeText(resumeCommand).then(
              () => toast(t('sessions.resumeCommandCopied', { command: resumeCommand })),
              () => toast(t('sessions.copyFailed')),
            );
          }}
          className={buttonClass}
          title={resumeCommand}
        >
          {t('sessions.copyResumeCommand')}
        </button>
        <button onClick={() => onOpenPullRequest(row.url)} className={buttonClass} title="⌘↩">
          {t('sessions.openPullRequest')} ↗
        </button>
      </div>
    </div>
  );
}

/**
 * A compact single-choice filter: trigger button + option list, styled like the
 * app's other menus (a native <select> pops the OS menu, which ignores the theme).
 * '' is the "all" choice. The list is absolutely positioned inside the board, so
 * it stays within the modal and never crosses into another panel.
 */
function FilterDropdown({ value, allLabel, options, onChange, className = '' }: {
  value: string;
  allLabel: string;
  options: readonly string[];
  onChange: (value: string) => void;
  className?: string;
}) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!rootRef.current?.contains(e.target as Node)) setOpen(false);
    };
    // Capture phase, so Esc closes only the menu and never reaches the board's
    // own window-level Esc handler, which would close the whole board.
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== 'Escape') return;
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown, true);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown, true);
    };
  }, [open]);

  const choose = (next: string) => {
    onChange(next);
    setOpen(false);
  };
  const items = ['', ...options];

  return (
    <div ref={rootRef} className={`relative ${className}`}>
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-haspopup="listbox"
        aria-expanded={open}
        className={`w-full flex items-center gap-1 px-2 py-1 text-xs rounded border bg-card text-left transition-colors ${
          open ? 'border-brand' : 'border-border hover:border-foreground-subtle'
        } ${value ? 'text-foreground' : 'text-muted-foreground'}`}
      >
        <span className="flex-1 min-w-0 truncate">{value || allLabel}</span>
        <svg className={`w-3 h-3 flex-shrink-0 text-foreground-subtle transition-transform ${open ? 'rotate-180' : ''}`} fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
        </svg>
      </button>
      {open && (
        <div
          role="listbox"
          className="absolute left-0 top-full mt-1 z-30 min-w-full max-w-[320px] max-h-64 overflow-y-auto bg-card border border-border rounded-lg shadow-lv2 py-1"
        >
          {items.map((item) => (
            <button
              key={item || '__all__'}
              type="button"
              role="option"
              aria-selected={item === value}
              onClick={() => choose(item)}
              className={`w-full flex items-center gap-2 px-3 py-1.5 text-xs text-left whitespace-nowrap hover:bg-hover transition-colors ${
                item === value ? 'text-brand' : 'text-foreground'
              }`}
            >
              <span className="w-3 flex-shrink-0">{item === value ? '✓' : ''}</span>
              <span className="truncate" data-tooltip={item || undefined}>{item || allLabel}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
