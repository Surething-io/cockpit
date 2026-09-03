'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from '@cockpit/shared-ui';
import { SubagentTranscriptModal } from './SubagentTranscriptModal';
import { WorkflowRunModal } from './WorkflowRunModal';
import type { ToolCallInfo } from './types';
// Tech debt: PreviewModal is a heavy main-shell component (depends on
// DiffView/CodeViewer/MarkdownRenderer/...). Pulling it cleanly would mean
// migrating its 11+ deps in lockstep. Allowed by MODULES.md as transitional
// reverse import. Clean up: extract a simpler preview primitive into shared,
// or migrate the relevant parts of PreviewModal into feature-agent later.
import { PreviewModal } from '@cockpit/feature-explorer';

// Migrated from src/components/project/ToolCallModal.tsx.

// ============================================
// Tool icon mapping
// ============================================

const TOOL_ICONS: Record<string, string> = {
  Read: '📄',
  Write: '✏️',
  Edit: '📝',
  ApplyPatch: '🧩',
  Bash: '💻',
  Glob: '🔍',
  Grep: '🔎',
  WebFetch: '🌐',
  WebSearch: '🔍',
  Workflow: '🧩',
  Skill: '🛠️',
};

// Extract the workflow run id (wf_xxx) from a Workflow tool call result. The
// launch text carries `Transcript dir: .../subagents/workflows/wf_<id>` even
// for background runs, so the id is available as soon as the call returns.
function parseWorkflowRunId(result?: string): string | null {
  if (!result) return null;
  return result.match(/subagents\/workflows\/(wf_[A-Za-z0-9_-]+)/)?.[1] ?? null;
}

function isPatchChange(value: unknown): value is { path?: unknown; kind?: unknown } {
  return typeof value === 'object' && value !== null;
}

// ============================================
// ToolCallModal - tool call display component
// ============================================

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
  // Enables the subagent transcript entry on Agent/Task tool calls
  sessionId?: string | null;
  /**
   * Drop the entries that open a window on top of the app — subagent transcript,
   * workflow run, input / result viewers. Expand/collapse and copy-path stay:
   * they mutate nothing outside this row. Set by hosts that are themselves
   * overlays (see MessageBubble's `disableOverlays`).
   */
  disableOverlays?: boolean;
}

export function ToolCallModal({ toolCall, cwd, sessionId, disableOverlays = false }: ToolCallProps) {
  const { t } = useTranslation();
  const [expanded, setExpanded] = useState(false);
  const [previewContent, setPreviewContent] = useState<{ title: string; content: string; toolName: string } | null>(null);
  const [showSubagent, setShowSubagent] = useState(false);
  const [showWorkflow, setShowWorkflow] = useState(false);

  const toolIcon = TOOL_ICONS[toolCall.name] || '🔧';
  const isAgentTool = toolCall.name === 'Agent' || toolCall.name === 'Task';
  const isSubagentCall = isAgentTool && !!cwd && !!sessionId;
  const isWorkflow = toolCall.name === 'Workflow';
  const workflowRunId = isWorkflow ? parseWorkflowRunId(toolCall.result) : null;
  // Workflow drill-in needs the run id plus the session coordinates to locate
  // the journal under `<sessionId>/workflows/`.
  const isWorkflowCall = isWorkflow && !!workflowRunId && !!cwd && !!sessionId;
  // The background task this call spawned is still working. Distinct from `isLoading` (= this
  // tool call has no result yet), which an async launch clears in ~30ms — see
  // shared/subagentTask.ts.
  //
  // Read straight off the status, with no "…and is a run active?" qualifier: `running` is only
  // ever written by a live event from the owning process (the disk parsers reconstruct `unknown`
  // instead, and settleRunningTasks clears it when the run ends). Qualifying it with a
  // session-level flag would be strictly worse than useless — it is true again as soon as the
  // user sends an UNRELATED next message, which is exactly how a stale task comes back to life.
  const taskRunning = toolCall.task?.status === 'running';
  const busy = !!toolCall.isLoading || taskRunning;
  /**
   * Poll gate for the sub-agent drill-in. Two engines, two different truths:
   *
   *  - claude/deepseek carry explicit task state, because a backgrounded Agent answers its own
   *    tool call in ~30ms and keeps working; `result` says nothing about the agent.
   *  - codex carries none, and does not need any: `spawn_agent`'s output is bookkeeping that
   *    session-by-path.ts deliberately does NOT store as the bubble's result, precisely so an
   *    unfinished sub-agent reads as "no result yet". That is also the ONLY signal there — the
   *    codex reload path hard-codes `isLoading: false` on every row.
   *
   * So: trust `task` when the engine provides it, keep the legacy test when it does not. The
   * `|| isLoading` arm covers a FOREGROUND claude subagent, whose spawning call genuinely does
   * block until it finishes.
   */
  const subagentRunning = toolCall.task ? taskRunning || !!toolCall.isLoading : !toolCall.result;
  // One-line liveness for a running task. Rendered instead of a bare spinner because
  // "WebFetch · 37" answers "is it stuck?" and a spinner does not.
  const taskProgress = taskRunning
    ? [toolCall.task?.lastToolName, toolCall.task?.toolUses ? String(toolCall.task.toolUses) : null]
        .filter(Boolean)
        .join(' · ')
    : '';
  const isSkill = toolCall.name === 'Skill';
  // The header text slot carries a description (Agent) / name (Workflow/Skill),
  // not a path — skip relative-path conversion and the copy-path icon for these.
  const hideCopyIcon = toolCall.name === 'ApplyPatch' || isAgentTool || isWorkflow || isSkill;

  // Extract file path or key info from input
  const getDisplayInfo = () => {
    const input = toolCall.input;
    if (toolCall.name === 'Bash' && input.command && typeof input.command === 'string') {
      return input.command;
    }
    if (toolCall.name === 'ApplyPatch' && Array.isArray(input.changes)) {
      const changes = input.changes.filter(isPatchChange).flatMap((change) => {
        const path = typeof change.path === 'string' ? change.path : '';
        if (!path) return [];
        const kind = typeof change.kind === 'string' && change.kind ? change.kind : 'update';
        return `${kind} ${getRelativePath(path)}`;
      });
      if (changes.length > 0) return changes.join(' · ');
    }
    if (isAgentTool && input.description && typeof input.description === 'string') {
      return input.description;
    }
    if (isWorkflow) {
      const name = typeof input.name === 'string' ? input.name : '';
      const detail =
        typeof input.args === 'string'
          ? input.args
          : typeof input.resumeFromRunId === 'string'
            ? input.resumeFromRunId
            : '';
      const label = [name, detail].filter(Boolean).join(' · ');
      if (label) return label;
    }
    if (isSkill && typeof input.skill === 'string') {
      const detail = typeof input.args === 'string' ? input.args : '';
      return [input.skill, detail].filter(Boolean).join(' · ');
    }
    if (toolCall.name === 'Glob' && input.pattern && typeof input.pattern === 'string') {
      return input.pattern;
    }
    if (toolCall.name === 'Grep' && input.pattern && typeof input.pattern === 'string') {
      return input.pattern;
    }
    if (toolCall.name === 'ToolSearch' && input.query && typeof input.query === 'string') {
      return input.query;
    }
    if (toolCall.name === 'TaskCreate' && input.subject && typeof input.subject === 'string') {
      return input.subject;
    }
    if (input.file_path && typeof input.file_path === 'string') {
      return input.file_path;
    }
    if (input.path && typeof input.path === 'string') {
      return input.path;
    }
    return null;
  };

  // Get path relative to cwd
  const getRelativePath = (fullPath: string) => {
    if (cwd && fullPath.startsWith(cwd)) {
      const relativePath = fullPath.slice(cwd.length);
      return relativePath.startsWith('/') ? relativePath.slice(1) : relativePath;
    }
    const parts = fullPath.split('/');
    if (parts.length > 2) {
      return '.../' + parts.slice(-2).join('/');
    }
    return fullPath;
  };

  const displayInfo = getDisplayInfo();
  const skipRelativePath = toolCall.name === 'Glob' || toolCall.name === 'Grep' || toolCall.name === 'Bash' || toolCall.name === 'ApplyPatch' || isAgentTool || isWorkflow || isSkill;
  const displayPath = displayInfo ? (skipRelativePath ? displayInfo : getRelativePath(displayInfo)) : null;

  const openPreview = (type: 'input' | 'result') => {
    const suffix = type === 'input' ? t('toolCall.inputParams') : t('toolCall.resultLabel');
    const content = type === 'input'
      ? JSON.stringify(toolCall.input, null, 2)
      : (typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2));
    setPreviewContent({
      title: `${toolCall.name}${displayPath ? ` ${displayPath}` : ''} - ${suffix}`,
      content,
      toolName: toolCall.name,
    });
  };

  return (
    // A list item, not a card: no fill, no rounding, and a hairline instead of
    // a full border. These rows are peers in a list — they do not each need to
    // be their own surface, and when they were, four alpha fills (bubble ->
    // group -> row -> code block) compounded into a visibly heavy stack. The
    // click affordance moves entirely onto hover, which is why the header
    // below keeps hover:bg-hover.
    <div className="border-b border-line-1 last:border-b-0">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-1.5 flex items-center gap-2 text-left hover:bg-hover transition-colors"
      >
        <span className="text-sm">{toolIcon}</span>
        <span className="font-medium text-sm text-foreground flex-shrink-0">
          {toolCall.name}
        </span>
        {displayPath && (
          <>
            <span
              className="text-xs text-muted-foreground truncate flex-1 min-w-0"
              data-tooltip={displayInfo || ''}
            >
              {displayPath}
            </span>
            {!hideCopyIcon && (
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  if (displayInfo) {
                    navigator.clipboard.writeText(displayInfo);
                    toast(t('common.copiedPath'));
                  }
                }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') {
                    e.stopPropagation();
                    if (displayInfo) {
                      navigator.clipboard.writeText(displayInfo);
                      toast(t('common.copiedPath'));
                    }
                  }
                }}
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0 cursor-pointer"
                title={t('common.copyAbsPath')}
              >
                <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                </svg>
              </span>
            )}
          </>
        )}
        {/* Right action area */}
        <span className="ml-auto flex items-center gap-2">
          {isSubagentCall && !disableOverlays && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setShowSubagent(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowSubagent(true); } }}
              className="text-xs text-brand hover:text-teal-10 cursor-pointer"
              title={t('chat.subagentViewTitle')}
            >
              {t('chat.subagent')}
            </span>
          )}
          {isWorkflowCall && !disableOverlays && (
            <span
              role="button"
              tabIndex={0}
              onClick={(e) => { e.stopPropagation(); setShowWorkflow(true); }}
              onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); setShowWorkflow(true); } }}
              className="text-xs text-brand hover:text-teal-10 cursor-pointer"
              title={t('chat.workflowViewTitle')}
            >
              {t('chat.workflowRun')}
            </span>
          )}
          {taskProgress && (
            <span className="text-xs text-muted-foreground truncate max-w-[16rem]">{taskProgress}</span>
          )}
          {expanded && !toolCall.isLoading && !disableOverlays && (
            <>
              <span
                role="button"
                tabIndex={0}
                onClick={(e) => { e.stopPropagation(); openPreview('input'); }}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); openPreview('input'); } }}
                className="text-xs text-brand hover:text-teal-10 cursor-pointer"
                title={t('toolCall.inputParamsTitle')}
              >
                {t('toolCall.input')}
              </span>
              {toolCall.result && (
                <span
                  role="button"
                  tabIndex={0}
                  onClick={(e) => { e.stopPropagation(); openPreview('result'); }}
                  onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.stopPropagation(); openPreview('result'); } }}
                  className="text-xs text-brand hover:text-teal-10 cursor-pointer"
                  title={t('toolCall.resultTitle')}
                >
                  {t('toolCall.result')}
                </span>
              )}
            </>
          )}
          {busy ? (
            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          ) : (
            <span className="text-foreground-subtle text-xs">
              {expanded ? '▲' : '▼'}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-line-1">
          <div className="px-3 py-2">
            <div className="mb-1">
              <span className="text-xs text-muted-foreground">{t('toolCall.inputParams')}:</span>
            </div>
            <pre className="text-xs bg-accent p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="px-3 py-2 border-t border-line-1">
              <div className="mb-1">
                <span className="text-xs text-muted-foreground">{t('toolCall.resultLabel')}:</span>
              </div>
              <pre className="text-xs bg-accent p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
                {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
              </pre>
            </div>
          )}

          {/* Skill body loaded by this call — folded here instead of shown as a user bubble */}
          {toolCall.skillContent && (
            <div className="px-3 py-2 border-t border-line-1">
              <div className="mb-1">
                <span className="text-xs text-muted-foreground">
                  {t('toolCall.skillContent', { defaultValue: 'Skill content' })}:
                </span>
              </div>
              <pre className="text-xs bg-accent p-2 rounded overflow-x-auto max-h-60 overflow-y-auto text-foreground whitespace-pre-wrap">
                {toolCall.skillContent}
              </pre>
            </div>
          )}
        </div>
      )}

      {/* Preview modal */}
      {previewContent && (
        <PreviewModal
          title={previewContent.title}
          content={previewContent.content}
          toolName={previewContent.toolName}
          onClose={() => setPreviewContent(null)}
        />
      )}

      {/* Subagent transcript modal */}
      {showSubagent && cwd && sessionId && (
        <SubagentTranscriptModal
          cwd={cwd}
          sessionId={sessionId}
          toolCall={toolCall}
          running={subagentRunning}
          onClose={() => setShowSubagent(false)}
        />
      )}

      {/* Workflow run modal */}
      {showWorkflow && cwd && sessionId && workflowRunId && (
        <WorkflowRunModal
          cwd={cwd}
          sessionId={sessionId}
          runId={workflowRunId}
          isRunning={busy}
          onClose={() => setShowWorkflow(false)}
        />
      )}
    </div>
  );
}
