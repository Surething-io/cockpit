'use client';

import { useState, useEffect, useRef, useCallback, Fragment } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '@cockpit/shared-ui';
import { BrowserRuntime } from '@cockpit/effect-runtime';
import { postSessionByPath } from './useChatHistory';
import { SubagentTranscriptModal, type WorkflowAgentRef } from './SubagentTranscriptModal';

// Drill-in for a Workflow tool call. Reads the run journal
// (`<sessionId>/workflows/<runId>.json`) via /api/session-by-path and renders
// run stats + the agents grouped by phase. Clicking an agent opens its full
// transcript (reusing SubagentTranscriptModal in workflow mode). Polls while
// the run is still in progress.

const POLL_INTERVAL_MS = 5_000;

interface WorkflowAgent {
  index?: number;
  label?: string;
  phaseIndex?: number;
  phaseTitle?: string;
  agentId?: string;
  model?: string;
  state?: string;
  tokens?: number;
  toolCalls?: number;
  durationMs?: number;
  lastToolName?: string;
  lastToolSummary?: string;
  promptPreview?: string;
  resultPreview?: string;
}

interface WorkflowJournalView {
  runId?: string;
  workflowName?: string;
  status?: string;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  phases?: Array<{ title?: string; detail?: string }>;
  summary?: string;
  agents?: WorkflowAgent[];
}

interface WorkflowRunModalProps {
  cwd: string;
  sessionId: string;
  runId: string;
  // Parent Workflow tool call has no result yet → run is (likely) in progress.
  isRunning: boolean;
  onClose: () => void;
}

function formatTokens(n?: number): string {
  if (!n) return '0';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}k`;
  return String(n);
}

function formatDuration(ms?: number): string {
  if (!ms) return '–';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m${s % 60}s`;
}

const STATE_COLOR: Record<string, string> = {
  done: 'text-green-9',
  running: 'text-brand',
  queued: 'text-muted-foreground',
  error: 'text-red-9',
  failed: 'text-red-9',
};

export function WorkflowRunModal({ cwd, sessionId, runId, isRunning, onClose }: WorkflowRunModalProps) {
  const { t } = useTranslation();
  const [journal, setJournal] = useState<WorkflowJournalView | null>(null);
  const [loadAttempted, setLoadAttempted] = useState(false);
  const [openAgent, setOpenAgent] = useState<WorkflowAgentRef | null>(null);
  const fingerprintRef = useRef<string | undefined>(undefined);

  // Once the parent run reports completion, the journal can still update for a
  // beat; keep polling until the journal's own status is terminal too.
  const journalRunning =
    isRunning || (journal != null && journal.status !== 'completed' && journal.status !== 'failed');

  const fetchJournal = useCallback(async () => {
    const exit = await BrowserRuntime.runPromiseExit(
      postSessionByPath({ cwd, sessionId, workflowId: runId, ifFingerprint: fingerprintRef.current })
    );
    setLoadAttempted(true);
    if (exit._tag !== 'Success' || !exit.value) return;
    const data = exit.value as {
      notModified?: boolean;
      fingerprint?: string;
      workflow?: WorkflowJournalView;
    };
    if (data.fingerprint) fingerprintRef.current = data.fingerprint;
    if (data.notModified) return;
    if (data.workflow) setJournal(data.workflow);
  }, [cwd, sessionId, runId]);

  useEffect(() => {
    fetchJournal();
    if (!journalRunning) return;
    const timer = setInterval(fetchJournal, POLL_INTERVAL_MS);
    return () => clearInterval(timer);
  }, [journalRunning, fetchJournal]);

  // Group agents by phase, preserving phase order from the journal.
  const groups: Array<{ title: string; agents: WorkflowAgent[] }> = [];
  if (journal?.agents) {
    const byPhase = new Map<string, WorkflowAgent[]>();
    for (const a of journal.agents) {
      const key = a.phaseTitle || t('chat.workflowUngrouped');
      if (!byPhase.has(key)) byPhase.set(key, []);
      byPhase.get(key)!.push(a);
    }
    for (const [title, agents] of byPhase) groups.push({ title, agents });
  }

  const stats = journal
    ? [
        journal.workflowName,
        journal.status,
        `${journal.agentCount ?? journal.agents?.length ?? 0} ${t('chat.workflowAgents')}`,
        `${formatTokens(journal.totalTokens)} tok`,
        formatDuration(journal.durationMs),
      ].filter(Boolean).join(' · ')
    : '';

  return (
    <Portal>
      <div
        className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
        onClick={onClose}
      >
        <div
          className="bg-card rounded-lg shadow-xl w-full max-w-[90%] h-[90vh] flex flex-col"
          onClick={(e) => e.stopPropagation()}
        >
          {/* Header */}
          <div className="flex items-center gap-2 px-4 py-3 border-b border-border flex-shrink-0">
            <span className="text-base">🧩</span>
            <span className="font-medium text-sm text-foreground flex-shrink-0">
              {t('chat.workflowRun')}
            </span>
            {stats && (
              <span className="text-xs text-muted-foreground truncate flex-1 min-w-0" title={stats}>
                {stats}
              </span>
            )}
            <span className="ml-auto flex items-center gap-2 flex-shrink-0">
              {journalRunning && (
                <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
              )}
              <button
                onClick={onClose}
                className="p-1 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors"
                title={t('common.close')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                </svg>
              </button>
            </span>
          </div>

          {/* Body */}
          <div className="flex-1 overflow-y-auto px-4 py-3">
            {journal === null ? (
              <div className="text-xs text-muted-foreground text-center py-4">
                {loadAttempted ? t('chat.workflowEmpty') : t('common.loading')}
              </div>
            ) : (
              <>
                {journal.summary && (
                  <div className="mb-3 text-xs text-muted-foreground whitespace-pre-wrap">
                    {journal.summary}
                  </div>
                )}
                {groups.map((g) => (
                  <Fragment key={g.title}>
                    <div className="text-xs font-semibold text-foreground/80 mt-3 mb-1 sticky top-0 bg-card py-1">
                      {g.title}
                    </div>
                    {g.agents.map((a) => (
                      <WorkflowAgentRow
                        key={`${a.index}-${a.agentId}`}
                        agent={a}
                        onOpen={() =>
                          a.agentId &&
                          setOpenAgent({
                            runId,
                            agentId: a.agentId,
                            label: a.label,
                            running: a.state !== 'done' && journalRunning,
                          })
                        }
                      />
                    ))}
                  </Fragment>
                ))}
              </>
            )}
          </div>
        </div>
      </div>

      {openAgent && (
        <SubagentTranscriptModal
          cwd={cwd}
          sessionId={sessionId}
          workflowRef={openAgent}
          onClose={() => setOpenAgent(null)}
        />
      )}
    </Portal>
  );
}

function WorkflowAgentRow({
  agent,
  onOpen,
}: {
  agent: WorkflowAgent;
  onOpen: () => void;
}) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const stateColor = (agent.state && STATE_COLOR[agent.state]) || 'text-muted-foreground';
  const preview = agent.resultPreview || agent.promptPreview || '';

  return (
    <div className="border border-border rounded-md mb-1 bg-secondary/50">
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          onClick={() => setExpanded((v) => !v)}
          className="text-slate-9 text-xs flex-shrink-0"
          title={expanded ? t('chat.collapse') : t('chat.expand')}
        >
          {expanded ? '▲' : '▼'}
        </button>
        <span className="text-xs text-foreground truncate flex-1 min-w-0" title={agent.label || ''}>
          {agent.label || agent.agentId}
        </span>
        <span className={`text-[10px] flex-shrink-0 ${stateColor}`}>{agent.state}</span>
        <span className="text-[10px] text-muted-foreground flex-shrink-0">
          {formatTokens(agent.tokens)} tok · {formatDuration(agent.durationMs)}
        </span>
        {agent.agentId && (
          <span
            role="button"
            tabIndex={0}
            onClick={onOpen}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') onOpen(); }}
            className="text-xs text-brand hover:text-teal-10 cursor-pointer flex-shrink-0"
            title={t('chat.subagentViewTitle')}
          >
            {t('chat.workflowViewAgent')}
          </span>
        )}
      </div>
      {expanded && preview && (
        <pre className="text-[11px] bg-secondary px-2 py-1.5 rounded-b overflow-x-auto max-h-32 overflow-y-auto text-muted-foreground whitespace-pre-wrap border-t border-border">
          {preview}
        </pre>
      )}
    </div>
  );
}
