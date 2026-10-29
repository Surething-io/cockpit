'use client'

import { memo, useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Bot, FolderOpen, FolderPlus, Trash2, X } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { BrowserRuntime } from '@cockpit/effect-runtime'
import { publishTopic } from '@cockpit/effect-react'
import { Topics } from '@cockpit/effect-services'
import { addBot, failureMessage, loadBots, notifyBotsChanged, removeBot, type BotInfo } from '@cockpit/shared-api'
import { MODAL_SHELL_CLASS, toast } from '@cockpit/shared-ui'
import { DirectoryPane } from '@cockpit/feature-skills'
import {
  EngineBadge,
  SessionNumberBadge,
  SessionTranscriptPreview,
  badgeStatus,
  dateGroupOf,
  formatRelativeTime,
  loadRecentSessions,
  loadSessionsByProject,
  statusLabelOf,
  type DateGroupKey,
  type RecentSessionInfo,
  type SessionListItem,
} from '@cockpit/feature-agent'
// Deep subpath, not the barrel — the barrel pulls in paths.ts (node fs/os/path).
import { encodePath } from '@cockpit/shared-utils/encodePath'

interface BotsModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  /** Switch to a session (the "sessions" tab's open action). */
  readonly onOpenSession: (cwd: string, sessionId: string) => void
}

type RightTab = 'files' | 'sessions'

/**
 * A session counts as this Bot's when either holds:
 *   - it runs IN the Bot's directory — how Bots are usually run: a scheduled
 *     task or a tab opened on the Bot folder, its prompt starting `@name`. These
 *     never carry a `bot` mark (that is reserved for delegated children, see
 *     shared/botSession.ts), so the directory is the only evidence;
 *   - it carries the Bot's `bot` mark — a child the Bot dispatched elsewhere
 *     (`Task: @name: …`).
 */
const isBotSession = (s: RecentSessionInfo, bot: BotInfo) =>
  s.bot === bot.name || s.cwd === bot.path || s.cwd.startsWith(bot.path + '/')

/**
 * Bot registry manager — same model as SkillsModal: Bots are created by the
 * `/bot` skill (or by hand) as plain directories with a BOT.md, then registered
 * here by path or from the explorer's BOT.md button. Removing only drops the
 * bot.json entry; the directory is kept.
 *
 * Board layout like the other sidebar boards: Bots on the left (the user's
 * own, then built-ins), the selected one on the right in two tabs —
 *   - Files: its directory (identity, memory, commitments, reports…), opened on
 *     BOT.md — the skills board's DirectoryPane over /api/bots/files;
 *   - Sessions: its runs — every session in its directory plus children it
 *     dispatched elsewhere (useBotSessions), date-grouped, with the same
 *     transcript preview the session boards use.
 */
export function BotsModal({ isOpen, onClose, onOpenSession }: BotsModalProps) {
  const { t } = useTranslation()
  const [bots, setBots] = useState<ReadonlyArray<BotInfo>>([])
  const [loading, setLoading] = useState(false)
  const [showAdd, setShowAdd] = useState(false)
  const [query, setQuery] = useState('')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [tab, setTab] = useState<RightTab>('files')
  const [confirmRemoveId, setConfirmRemoveId] = useState<string | null>(null)
  // Recent sessions, fetched per open; the Sessions tab filters them by Bot.
  const [sessions, setSessions] = useState<ReadonlyArray<RecentSessionInfo>>([])

  const reload = useCallback(async () => {
    setLoading(true)
    const exit = await BrowserRuntime.runPromiseExit(loadBots())
    if (exit._tag === 'Success') setBots(exit.value)
    else toast(failureMessage(exit.cause, t('bots.loadFailed')), 'error')
    setLoading(false)
  }, [t])

  useEffect(() => {
    if (!isOpen) {
      setSelectedId(null)
      setConfirmRemoveId(null)
      return
    }
    void reload()
    void BrowserRuntime.runPromiseExit(loadRecentSessions()).then((exit) => {
      if (exit._tag === 'Success') setSessions(exit.value)
    })
  }, [isOpen, reload])

  useEffect(() => {
    if (!isOpen) return
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== 'Escape') return
      if (showAdd) setShowAdd(false)
      else onClose()
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [showAdd, isOpen, onClose])

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (!needle) return bots
    return bots.filter((bot) => {
      const detail = bot.valid ? bot.description : bot.error
      return `${bot.name}\n${detail}\n${bot.path}`.toLowerCase().includes(needle)
    })
  }, [bots, query])

  // The user's own Bots first, then built-ins — two groups, names sorted.
  const groups = useMemo(() => {
    const byName = (a: BotInfo, b: BotInfo) => a.name.localeCompare(b.name)
    return [
      { key: 'mine', labelKey: 'bots.mine', items: filtered.filter((b) => !b.builtin).slice().sort(byName) },
      { key: 'builtin', labelKey: 'bots.builtin', items: filtered.filter((b) => b.builtin).slice().sort(byName) },
    ].filter((g) => g.items.length > 0)
  }, [filtered])
  const flat = useMemo(() => groups.flatMap((g) => g.items), [groups])
  const selected = selectedId ? bots.find((b) => b.id === selectedId) ?? null : null

  // Auto-select the first row; only fills a hole (nothing selected, or removed).
  useEffect(() => {
    if (!isOpen || selected) return
    setSelectedId(flat[0]?.id ?? null)
  }, [isOpen, selected, flat])


  // Built-in Bots ship with Cockpit and are always present, so they must not
  // count towards "is this panel empty?" — otherwise the first-run guidance
  // below could never appear again, and `filtered.length === 0` (the old empty
  // state) became unreachable the moment the first built-in was added.
  const userBotCount = useMemo(() => bots.filter((bot) => !bot.builtin).length, [bots])
  const searching = query.trim().length > 0
  const showGuidance = !searching && userBotCount === 0

  const unregister = useCallback(async (id: string) => {
    const exit = await BrowserRuntime.runPromiseExit(removeBot(id))
    if (exit._tag === 'Success') {
      setBots((current) => current.filter((bot) => bot.id !== id))
      notifyBotsChanged()
      toast(t('bots.removed'), 'success')
    } else {
      toast(failureMessage(exit.cause, t('bots.removeFailed')), 'error')
    }
  }, [t])

  // A Bot directory is an ordinary folder, so the project panels (explorer,
  // markdown preview, git) are the natural way to read and edit it. Opening it
  // as a project goes through the same OpenProject topic the session browser
  // and worktree switch use; in the top frame `window.parent` is this window,
  // so Workspace's own OPEN_PROJECT handler picks it up.
  const openAsProject = useCallback((path: string) => {
    publishTopic(Topics.OpenProject, { cwd: path, file: 'BOT.md' })
    onClose()
  }, [onClose])

  const openAdd = useCallback(() => setShowAdd(true), [])
  const closeAdd = useCallback(() => setShowAdd(false), [])
  const onAdded = useCallback(async () => {
    setShowAdd(false)
    await reload()
  }, [reload])

  if (!isOpen) return null

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      <div className="absolute inset-0 bg-scrim" onClick={onClose} />
      <div className={MODAL_SHELL_CLASS}>
        <div className="flex items-center justify-between gap-3 px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-foreground">{t('bots.title')}</h2>
          <div className="flex items-center gap-2">
            <input
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder={t('bots.search')}
              className="px-2 py-1 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
            />
            <button
              onClick={openAdd}
              className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border hover:bg-hover"
            >
              <FolderPlus className="w-4 h-4" />
              {t('bots.addExisting')}
            </button>
            <button onClick={onClose} className="p-1 text-muted-foreground hover:text-foreground">
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>
        <div className="flex-1 flex min-h-0">
          {/* Left: Bots, grouped. Padding stays off the scroll node so the
              sticky group header does not leave a strip of rows above it. */}
          <div className="w-full md:w-[300px] min-h-0 flex-shrink-0 md:border-r border-border overflow-y-auto">
            {loading && bots.length === 0 ? (
              <p className="text-center text-sm text-muted-foreground py-8">{t('common.loading')}</p>
            ) : (
              <div className="p-3 space-y-3">
                {groups.map((group) => (
                  <div key={group.key} className="rounded-lg border border-border">
                    <div className="sticky top-0 z-10 px-3 py-1.5 bg-card rounded-t-lg border-b border-border/60 text-[11px] font-medium text-muted-foreground flex items-center">
                      <span>{t(group.labelKey)}</span>
                      <span className="ml-auto tabular-nums text-foreground-subtle">{group.items.length}</span>
                    </div>
                    <div className="p-1 space-y-0.5">
                      {group.items.map((bot) => (
                        <BotRow
                          key={bot.id}
                          bot={bot}
                          selected={bot.id === selectedId}
                          onSelect={setSelectedId}
                        />
                      ))}
                    </div>
                  </div>
                ))}

                {flat.length === 0 && searching && (
                  <p className="text-center text-xs text-muted-foreground py-6">{t('bots.emptyNoMatch')}</p>
                )}

                {/* Guidance is keyed to *user* Bots, so it survives the built-in
                    rows always being present. */}
                {showGuidance && (
                  <div className="text-center text-muted-foreground py-4 text-xs space-y-2">
                    <p>{t('bots.emptyNoBots')}</p>
                    <p>
                      {t('bots.emptyCreatePrefix')}{' '}
                      <code className="px-1.5 py-0.5 rounded bg-muted text-foreground font-mono text-xs">/bot</code>
                      {' '}{t('bots.emptyCreateSuffix')}
                    </p>
                    <p>
                      <button type="button" onClick={openAdd} className="text-brand hover:underline">
                        {t('bots.emptyAddExisting')}
                      </button>
                    </p>
                  </div>
                )}
              </div>
            )}
          </div>

          {/* Right: the selected Bot */}
          <div className="hidden md:flex flex-1 min-w-0">
            {selected ? (
              <BotDetail
                key={selected.id}
                bot={selected}
                tab={tab}
                onTab={setTab}
                sessions={sessions}
                confirmingRemove={confirmRemoveId === selected.id}
                onAskRemove={() => setConfirmRemoveId(selected.id)}
                onCancelRemove={() => setConfirmRemoveId(null)}
                onRemove={() => { setConfirmRemoveId(null); void unregister(selected.id) }}
                onOpenAsProject={() => openAsProject(selected.path)}
                onOpenSession={(cwd, sessionId) => { onOpenSession(cwd, sessionId); onClose() }}
                onClose={onClose}
              />
            ) : (
              <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">
                {t('bots.selectHint')}
              </div>
            )}
          </div>
        </div>
      </div>

      {showAdd && <AddBotDialog onCancel={closeAdd} onAdded={onAdded} />}
    </div>
  )
}

interface BotRowProps {
  readonly bot: BotInfo
  readonly selected: boolean
  /** Stable identity (state setter) so memo holds across modal re-renders. */
  readonly onSelect: (id: string) => void
}

const BotRow = memo(function BotRow({ bot, selected, onSelect }: BotRowProps) {
  const { t } = useTranslation()
  const detail = bot.valid ? bot.description : bot.error
  return (
    <div
      onClick={() => onSelect(bot.id)}
      className={`rounded-md px-2 py-2 cursor-pointer transition-colors ${selected ? 'bg-brand/10' : 'hover:bg-hover'}`}
    >
      <div className="flex items-center gap-2 min-w-0">
        <Bot className="w-4 h-4 text-brand flex-shrink-0" />
        <span className="font-medium text-xs text-foreground truncate flex-1 min-w-0" data-tooltip={bot.path}>@{bot.name}</span>
        {!bot.valid && <span className="text-[10px] text-destructive flex-shrink-0">{t('bots.invalid')}</span>}
      </div>
      <p
        className={`text-xs mt-0.5 pl-6 truncate ${bot.valid ? 'text-muted-foreground' : 'text-destructive'}`}
        data-tooltip={detail || undefined}
      >
        {detail}
      </p>
    </div>
  )
})

interface BotDetailProps {
  readonly bot: BotInfo
  readonly tab: RightTab
  readonly onTab: (tab: RightTab) => void
  readonly sessions: ReadonlyArray<RecentSessionInfo>
  readonly confirmingRemove: boolean
  readonly onAskRemove: () => void
  readonly onCancelRemove: () => void
  readonly onRemove: () => void
  readonly onOpenAsProject: () => void
  readonly onOpenSession: (cwd: string, sessionId: string) => void
  readonly onClose: () => void
}

/** Right pane: header controls shared by both tabs, then Files or Sessions. */
function BotDetail({
  bot, tab, onTab, sessions, confirmingRemove, onAskRemove, onCancelRemove, onRemove, onOpenAsProject, onOpenSession, onClose,
}: BotDetailProps) {
  const { t } = useTranslation()
  const botSessions = useBotSessions(bot, sessions)

  const tabButton = (key: RightTab, label: string) => (
    <button
      onClick={() => onTab(key)}
      className={`px-3 py-1 transition-colors ${
        tab === key ? 'bg-brand text-white' : 'text-muted-foreground hover:text-foreground hover:bg-hover'
      }`}
    >
      {label}
    </button>
  )

  const controls: ReactNode = (
    <div className="flex items-center gap-2 flex-shrink-0">
      <div className="flex items-center rounded-md border border-border overflow-hidden text-xs">
        {tabButton('files', t('bots.tabFiles'))}
        {tabButton('sessions', `${t('bots.tabSessions')}${botSessions.rows.length ? ` ${botSessions.rows.length}` : ''}`)}
      </div>
      <button
        onClick={onOpenAsProject}
        className="p-1.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover"
        data-tooltip={t('bots.open')}
        aria-label={t('bots.open')}
      >
        <FolderOpen className="w-4 h-4" />
      </button>
      {/* Built-ins are virtual — there is no bot.json entry to remove. Removing
          only drops the registration, but the row vanishing reads as data loss,
          so it takes a second click. */}
      {bot.builtin ? null : confirmingRemove ? (
        <div className="flex items-center gap-1">
          <button onClick={onRemove} className="px-2 py-1 text-xs rounded bg-red-9 text-white hover:bg-red-10">
            {t('bots.remove')}
          </button>
          <button onClick={onCancelRemove} className="px-2 py-1 text-xs rounded border border-border text-muted-foreground hover:text-foreground">
            {t('common.cancel')}
          </button>
        </div>
      ) : (
        <button
          onClick={onAskRemove}
          className="p-1.5 rounded text-muted-foreground hover:text-destructive hover:bg-red-9/10"
          data-tooltip={t('bots.remove')}
          aria-label={t('bots.remove')}
        >
          <Trash2 className="w-4 h-4" />
        </button>
      )}
    </div>
  )

  if (tab === 'files') {
    return (
      <DirectoryPane
        endpoint="/api/bots/files"
        id={bot.id}
        entryFile="BOT.md"
        title={`@${bot.name}`}
        actions={controls}
        onClose={onClose}
      />
    )
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 min-h-0">
      <div className="flex items-center gap-3 px-4 py-3 border-b border-border flex-shrink-0">
        <div className="flex-1 min-w-0">
          <h2 className="text-sm font-medium text-foreground truncate">@{bot.name}</h2>
          <div className="text-xs text-muted-foreground mt-0.5">{t('bots.sessionsScope')}</div>
        </div>
        {controls}
      </div>
      <BotSessions data={botSessions} onOpenSession={onOpenSession} />
    </div>
  )
}

/** One row of the Sessions tab, from either source (see useBotSessions). */
interface BotSessionRow {
  cwd: string
  sessionId: string
  title: string
  /** Last activity, ms. */
  time: number
  engine?: RecentSessionInfo['engine']
  bot?: string
  /** Running / unread — known only for sessions still in the recent list. */
  status?: string
  lastMessage?: string
}

const rowKey = (cwd: string, sessionId: string) => `${cwd}\n${sessionId}`

/**
 * The Bot's sessions, from two sources merged:
 *   - every session in its directory (/api/sessions/projects — all engines,
 *     no time limit beyond the engines' own transcript cleanup);
 *   - children it dispatched elsewhere (`bot` mark) and runs in a subfolder,
 *     which only the recent-sessions list (about a week) knows.
 * Running / unread status comes from the recent list where the session is in it.
 * Newest first; `loadedAt` is the "now" the date groups are cut against.
 */
function useBotSessions(bot: BotInfo, recent: ReadonlyArray<RecentSessionInfo>) {
  const [dirSessions, setDirSessions] = useState<ReadonlyArray<SessionListItem> | null>(null)
  const [loadedAt, setLoadedAt] = useState(0)

  useEffect(() => {
    let cancelled = false
    void BrowserRuntime.runPromiseExit(loadSessionsByProject<SessionListItem>(encodePath(bot.path))).then((exit) => {
      if (cancelled) return
      setDirSessions(exit._tag === 'Success' ? exit.value : [])
      setLoadedAt(Date.now())
    })
    return () => { cancelled = true }
  }, [bot.path])

  const rows = useMemo(() => {
    const recentByKey = new Map(recent.map((s) => [rowKey(s.cwd, s.sessionId), s]))
    const out = new Map<string, BotSessionRow>()
    for (const item of dirSessions ?? []) {
      const sessionId = item.sessionId || (item.path.split('/').pop() || '').replace(/\.jsonl$/, '')
      const key = rowKey(bot.path, sessionId)
      const live = recentByKey.get(key)
      out.set(key, {
        cwd: bot.path,
        sessionId,
        title: item.title,
        time: Math.max(Date.parse(item.modifiedAt) || 0, live?.lastActive ?? 0),
        engine: item.engine,
        bot: item.bot,
        status: live?.status,
        lastMessage: live?.lastUserMessage ?? item.lastMessages[item.lastMessages.length - 1] ?? item.firstMessages[0],
      })
    }
    for (const s of recent) {
      if (!isBotSession(s, bot)) continue
      const key = rowKey(s.cwd, s.sessionId)
      if (out.has(key)) continue
      out.set(key, {
        cwd: s.cwd,
        sessionId: s.sessionId,
        title: s.title || s.sessionId.slice(0, 8),
        time: s.lastActive,
        engine: s.engine,
        bot: s.bot,
        status: s.status,
        lastMessage: s.lastUserMessage,
      })
    }
    return [...out.values()].sort((a, b) => b.time - a.time)
  }, [dirSessions, recent, bot])

  return { rows, loading: dirSessions === null, loadedAt }
}

const DATE_GROUPS: ReadonlyArray<{ key: DateGroupKey; labelKey: string }> = [
  { key: 'today', labelKey: 'sessions.dateToday' },
  { key: 'yesterday', labelKey: 'sessions.dateYesterday' },
  { key: 'last7Days', labelKey: 'sessions.dateLast7Days' },
  { key: 'earlier', labelKey: 'sessions.dateEarlier' },
]

interface BotSessionsProps {
  readonly data: ReturnType<typeof useBotSessions>
  readonly onOpenSession: (cwd: string, sessionId: string) => void
}

/** The Bot's runs: a date-grouped list and the selected run's transcript. */
function BotSessions({ data, onOpenSession }: BotSessionsProps) {
  const { t } = useTranslation()
  const { rows, loading, loadedAt } = data
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selected = rows.find((r) => rowKey(r.cwd, r.sessionId) === selectedKey) ?? rows[0] ?? null

  const groups = useMemo(() => {
    const byGroup = new Map<DateGroupKey, BotSessionRow[]>()
    for (const r of rows) {
      const g = dateGroupOf(r.time, loadedAt)
      const list = byGroup.get(g)
      if (list) list.push(r)
      else byGroup.set(g, [r])
    }
    return DATE_GROUPS.map((g) => ({ ...g, items: byGroup.get(g.key) ?? [] })).filter((g) => g.items.length > 0)
  }, [rows, loadedAt])

  if (loading && rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">{t('common.loading')}</div>
  }
  if (rows.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">{t('bots.noSessions')}</div>
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-72 flex-shrink-0 border-r border-border overflow-y-auto">
        <div className="p-2 space-y-2">
          {groups.map((group) => (
            <div key={group.key} className="rounded-lg border border-border">
              <div className="sticky top-0 z-10 px-3 py-1.5 bg-card rounded-t-lg border-b border-border/60 text-[11px] font-medium text-muted-foreground flex items-center">
                <span>{t(group.labelKey)}</span>
                <span className="ml-auto tabular-nums text-foreground-subtle">{group.items.length}</span>
              </div>
              <div className="p-1 space-y-0.5">
                {group.items.map((r) => {
                  const key = rowKey(r.cwd, r.sessionId)
                  const isSelected = !!selected && rowKey(selected.cwd, selected.sessionId) === key
                  return (
                    <div
                      key={key}
                      onClick={() => setSelectedKey(key)}
                      onDoubleClick={() => onOpenSession(r.cwd, r.sessionId)}
                      className={`rounded-md px-2 py-2 cursor-pointer transition-colors ${isSelected ? 'bg-brand/10' : 'hover:bg-hover'}`}
                    >
                      <div className="flex items-center gap-1.5 min-w-0">
                        <EngineBadge engine={r.engine} />
                        <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0" data-tooltip={r.title}>{r.title}</span>
                        <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatRelativeTime(t, r.time)}</span>
                        <SessionNumberBadge status={badgeStatus(r.status)} statusLabel={statusLabelOf(t, r.status)} bot={r.bot} />
                      </div>
                      {r.lastMessage && (
                        <div className="text-xs text-muted-foreground truncate mt-0.5 pl-[22px]" data-tooltip={r.lastMessage}>
                          {r.lastMessage}
                        </div>
                      )}
                    </div>
                  )
                })}
              </div>
            </div>
          ))}
        </div>
      </div>
      <div className="flex-1 flex min-w-0">
        {selected && (
          <SessionTranscriptPreview
            key={rowKey(selected.cwd, selected.sessionId)}
            cwd={selected.cwd}
            sessionId={selected.sessionId}
            subtitle={selected.title}
            emptyText={t('sessions.noSessionMessages')}
            onOpenSession={() => onOpenSession(selected.cwd, selected.sessionId)}
          />
        )}
      </div>
    </div>
  )
}

interface AddBotDialogProps {
  readonly onCancel: () => void
  /** Called after a successful registration (new or already present). */
  readonly onAdded: () => void
}

function AddBotDialog({ onCancel, onAdded }: AddBotDialogProps) {
  const { t } = useTranslation()
  const [path, setPath] = useState('')
  const [saving, setSaving] = useState(false)

  const save = useCallback(async () => {
    const value = path.trim()
    if (!value || saving) return
    setSaving(true)
    const exit = await BrowserRuntime.runPromiseExit(addBot(value))
    setSaving(false)
    if (exit._tag === 'Success') {
      const { alreadyExists } = exit.value
      toast(t(alreadyExists ? 'bots.alreadyAdded' : 'bots.added'), alreadyExists ? 'info' : 'success')
      if (!alreadyExists) notifyBotsChanged()
      onAdded()
    } else {
      toast(failureMessage(exit.cause, t('bots.saveFailed')), 'error')
    }
  }, [path, saving, onAdded, t])

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      <div className="absolute inset-0 bg-scrim" onClick={() => !saving && onCancel()} />
      <div className="relative w-full max-w-md rounded-xl border border-border bg-card p-5 shadow-xl">
        <h3 className="text-sm font-medium text-foreground mb-4">{t('bots.addExisting')}</h3>
        <input
          autoFocus
          value={path}
          onChange={(event) => setPath(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && !event.nativeEvent.isComposing) void save()
          }}
          placeholder={t('bots.pathPlaceholder')}
          className="w-full px-3 py-2 text-sm font-mono border border-border rounded bg-background"
        />
        <p className="text-xs text-muted-foreground mt-3">{t('bots.addHint')}</p>
        <div className="flex justify-end gap-2 mt-5">
          <button disabled={saving} onClick={onCancel} className="px-3 py-1.5 text-xs rounded border border-border">
            {t('common.cancel')}
          </button>
          <button
            disabled={saving || !path.trim()}
            onClick={() => void save()}
            className="px-3 py-1.5 text-xs rounded bg-brand text-white disabled:opacity-50"
          >
            {saving ? t('common.loading') : t('common.confirm')}
          </button>
        </div>
      </div>
    </div>
  )
}
