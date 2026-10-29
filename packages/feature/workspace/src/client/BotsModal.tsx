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
  formatRelativeTime,
  loadRecentSessions,
  sortSessionsForDisplay,
  statusLabelOf,
  type RecentSessionInfo,
} from '@cockpit/feature-agent'

interface BotsModalProps {
  readonly isOpen: boolean
  readonly onClose: () => void
  /** Switch to a session (the "sessions" tab's open action). */
  readonly onOpenSession: (cwd: string, sessionId: string) => void
}

type RightTab = 'files' | 'sessions'

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
 *   - Sessions: the runs it dispatched, read from the recent-sessions list
 *     (week-bounded) by each session's `bot` field, with the same transcript
 *     preview the session boards use.
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

  const sessionCounts = useMemo(() => {
    const counts = new Map<string, number>()
    for (const s of sessions) if (s.bot) counts.set(s.bot, (counts.get(s.bot) ?? 0) + 1)
    return counts
  }, [sessions])

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
                          sessionCount={sessionCounts.get(bot.name) ?? 0}
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
  /** Recent sessions this Bot dispatched (week-bounded). */
  readonly sessionCount: number
  /** Stable identity (state setter) so memo holds across modal re-renders. */
  readonly onSelect: (id: string) => void
}

const BotRow = memo(function BotRow({ bot, selected, sessionCount, onSelect }: BotRowProps) {
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
        {sessionCount > 0 && (
          <span className="text-[10px] tabular-nums text-foreground-subtle flex-shrink-0" data-tooltip={t('bots.sessionCount', { count: sessionCount })}>
            {sessionCount}
          </span>
        )}
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
  const botSessions = useMemo(
    () => sortSessionsForDisplay(sessions.filter((s) => s.bot === bot.name)),
    [sessions, bot.name],
  )

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
        {tabButton('sessions', `${t('bots.tabSessions')}${botSessions.length ? ` ${botSessions.length}` : ''}`)}
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
      <BotSessions sessions={botSessions} onOpenSession={onOpenSession} />
    </div>
  )
}

interface BotSessionsProps {
  readonly sessions: ReadonlyArray<RecentSessionInfo>
  readonly onOpenSession: (cwd: string, sessionId: string) => void
}

const keyOf = (s: RecentSessionInfo) => `${s.cwd}\n${s.sessionId}`

/** The Bot's runs: a list and the selected run's transcript. */
function BotSessions({ sessions, onOpenSession }: BotSessionsProps) {
  const { t } = useTranslation()
  const [selectedKey, setSelectedKey] = useState<string | null>(null)
  const selected = sessions.find((s) => keyOf(s) === selectedKey) ?? sessions[0] ?? null

  if (sessions.length === 0) {
    return <div className="flex-1 flex items-center justify-center text-xs text-muted-foreground">{t('bots.noSessions')}</div>
  }

  return (
    <div className="flex-1 flex min-h-0">
      <div className="w-64 flex-shrink-0 border-r border-border overflow-y-auto p-1 space-y-0.5">
        {sessions.map((s) => {
          const key = keyOf(s)
          const title = s.title || s.sessionId.slice(0, 8)
          return (
            <div
              key={key}
              onClick={() => setSelectedKey(key)}
              onDoubleClick={() => onOpenSession(s.cwd, s.sessionId)}
              className={`rounded-md px-2 py-2 cursor-pointer transition-colors ${
                selected && keyOf(selected) === key ? 'bg-brand/10' : 'hover:bg-hover'
              }`}
            >
              <div className="flex items-center gap-1.5 min-w-0">
                <EngineBadge engine={s.engine} />
                <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0" data-tooltip={title}>{title}</span>
                <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatRelativeTime(t, s.lastActive)}</span>
                <SessionNumberBadge status={badgeStatus(s.status)} statusLabel={statusLabelOf(t, s.status)} bot={s.bot} />
              </div>
              <div className="text-xs text-muted-foreground truncate mt-0.5 pl-[22px]" data-tooltip={s.cwd}>
                {s.cwd.split('/').filter(Boolean).pop()}
              </div>
            </div>
          )
        })}
      </div>
      <div className="flex-1 flex min-w-0">
        {selected && (
          <SessionTranscriptPreview
            key={keyOf(selected)}
            cwd={selected.cwd}
            sessionId={selected.sessionId}
            subtitle={selected.title || selected.sessionId.slice(0, 8)}
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
