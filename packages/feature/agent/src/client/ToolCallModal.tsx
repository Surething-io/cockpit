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

// ============================================
// ToolCallModal - tool call display component
// ============================================

interface ToolCallProps {
  toolCall: ToolCallInfo;
  cwd?: string;
  // Enables the subagent transcript entry on Agent/Task tool calls
  sessionId?: string | null;
}

export function ToolCallModal({ toolCall, cwd, sessionId }: ToolCallProps) {
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
  const isSkill = toolCall.name === 'Skill';
  // The header text slot carries a description (Agent) / name (Workflow/Skill),
  // not a path — skip relative-path conversion and the copy-path icon for these.
  const hideCopyIcon = isAgentTool || isWorkflow || isSkill;

  // Extract file path or key info from input
  const getDisplayInfo = () => {
    const input = toolCall.input;
    if (toolCall.name === 'Bash' && input.command && typeof input.command === 'string') {
      return input.command;
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
  const skipRelativePath = toolCall.name === 'Glob' || toolCall.name === 'Grep' || toolCall.name === 'Bash' || isAgentTool || isWorkflow || isSkill;
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
    <div className="my-2 border border-border rounded-lg overflow-hidden bg-secondary">
      <button
        onClick={() => setExpanded(!expanded)}
        className="w-full px-3 py-2 flex items-center gap-2 text-left hover:bg-accent transition-colors"
      >
        <span className="text-base">{toolIcon}</span>
        <span className="font-medium text-sm text-foreground flex-shrink-0">
          {toolCall.name}
        </span>
        {displayPath && (
          <>
            <span
              className="text-xs text-muted-foreground truncate flex-1 min-w-0"
              title={displayInfo || ''}
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
                className="p-0.5 rounded text-muted-foreground hover:text-foreground hover:bg-accent transition-colors flex-shrink-0 cursor-pointer"
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
          {isSubagentCall && (
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
          {isWorkflowCall && (
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
          {expanded && !toolCall.isLoading && (
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
          {toolCall.isLoading ? (
            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          ) : (
            <span className="text-slate-9 text-xs">
              {expanded ? '▲' : '▼'}
            </span>
          )}
        </span>
      </button>

      {expanded && (
        <div className="border-t border-border">
          <div className="px-3 py-2">
            <div className="mb-1">
              <span className="text-xs text-muted-foreground">{t('toolCall.inputParams')}:</span>
            </div>
            <pre className="text-xs bg-secondary p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
              {JSON.stringify(toolCall.input, null, 2)}
            </pre>
          </div>

          {toolCall.result && (
            <div className="px-3 py-2 border-t border-border">
              <div className="mb-1">
                <span className="text-xs text-muted-foreground">{t('toolCall.resultLabel')}:</span>
              </div>
              <pre className="text-xs bg-secondary p-2 rounded overflow-x-auto max-h-24 overflow-y-auto text-foreground">
                {typeof toolCall.result === 'string' ? toolCall.result : JSON.stringify(toolCall.result, null, 2)}
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
          onClose={() => setShowSubagent(false)}
        />
      )}

      {/* Workflow run modal */}
      {showWorkflow && cwd && sessionId && workflowRunId && (
        <WorkflowRunModal
          cwd={cwd}
          sessionId={sessionId}
          runId={workflowRunId}
          isRunning={!!toolCall.isLoading}
          onClose={() => setShowWorkflow(false)}
        />
      )}
    </div>
  );
}
