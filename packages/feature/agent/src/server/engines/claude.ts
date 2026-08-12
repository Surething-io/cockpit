import {
  sanitizedSpawnEnv,
  getClaudeSessionPath,
} from '@cockpit/shared-utils';
import { getSessionTitle } from '../state/globalState';
import { runSdkLoop, type BuildSdkOptions } from './shared/sdkLoop';
import { stashTranscript, mergeStashedTranscript } from './shared/noHistoryTranscript';
import type { EngineSpec, RunCtx } from './types';

type PlanPermissionResult =
  | { behavior: 'allow'; updatedInput: Record<string, unknown> }
  | { behavior: 'deny'; message: string; interrupt?: boolean };

const PLAN_EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit']);
/** True for paths inside a `.claude/plans/` directory (project- or home-relative). */
const isPlanFilePath = (p: string): boolean => /(^|\/)\.claude\/plans\//.test(p);
const CLAUDE_SDK_EFFORTS = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const CLAUDE_ULTRACODE_MODELS = new Set(['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8']);
const CLAUDE_XHIGH_MODELS = new Set(['claude-fable-5', 'claude-opus-5', 'claude-opus-4-8', 'claude-sonnet-5']);

function resolveClaudeModel(ctx: RunCtx): string | undefined {
  const model = typeof ctx.params.model === 'string' && ctx.params.model.trim()
    ? ctx.params.model.trim()
    : undefined;
  if (!model) return undefined;
  return ctx.params.claudeContextWindow === '1m' ? `${model}[1m]` : model;
}

function resolveClaudeEffort(ctx: RunCtx): string | undefined {
  const model = typeof ctx.params.model === 'string' ? ctx.params.model.trim() : '';
  if (model === 'claude-haiku-4-5') return undefined;
  const effort = typeof ctx.params.claudeEffort === 'string' ? ctx.params.claudeEffort : undefined;
  if (!effort || effort === 'ultrathink') return undefined;
  if (effort === 'ultracode') return 'xhigh';
  if (effort === 'xhigh' && !CLAUDE_XHIGH_MODELS.has(model)) return 'max';
  if (effort === 'max' && model === 'claude-sonnet-4-6') return 'high';
  return CLAUDE_SDK_EFFORTS.has(effort) ? effort : undefined;
}

function resolveClaudeSettings(ctx: RunCtx): Record<string, unknown> | undefined {
  const settings: Record<string, unknown> = {};
  const model = typeof ctx.params.model === 'string' ? ctx.params.model.trim() : '';
  if (ctx.params.claudeFastMode === true) settings.fastMode = true;
  if (ctx.params.claudeThinking !== undefined) settings.alwaysThinkingEnabled = ctx.params.claudeThinking;
  if (ctx.params.claudeEffort === 'ultracode' && CLAUDE_ULTRACODE_MODELS.has(model)) settings.ultracode = true;
  return Object.keys(settings).length > 0 ? settings : undefined;
}

function withClaudePromptEffort(ctx: RunCtx): RunCtx {
  if (ctx.params.claudeEffort !== 'ultrathink') return ctx;
  const prompt = ctx.prompt ?? '';
  if (/\bultrathink\b/i.test(prompt)) return ctx;
  return { ...ctx, prompt: `Ultrathink:\n${prompt}` };
}

/**
 * Plan-mode permission resolver. There is NO interactive approval dialog in this environment, so
 * every tool that would raise a permission prompt must be resolved here — otherwise the request
 * hangs and the call fails silently (e.g. the plan markdown write under the protected `.claude/`
 * dir was being denied as a "sensitive file").
 *
 *  - ExitPlanMode → deny+interrupt: the turn ends the first time the model presents its plan; the
 *    user approves by turning off Plan mode (plan card button) and resending.
 *  - Write/Edit to `.claude/plans/**` → allow: this IS the plan artifact, not a code edit. (A)
 *  - Any other file edit → deny with a model-visible reason (plan mode is read-only), so the model
 *    adapts instead of receiving a blank result from a silently-dropped permission. (C)
 */
export function planPermission(
  toolName: string,
  input: Record<string, unknown>,
  opts?: { blockedPath?: string },
): PlanPermissionResult {
  if (toolName === 'ExitPlanMode') {
    return {
      behavior: 'deny',
      message:
        'Plan presented to the user. There is no approval dialog to click in this environment — the user approves by turning off Plan mode (via the plan card button) and resending, which then executes. Do not ask the user to confirm in a popup; stop here.',
      interrupt: true,
    };
  }
  if (PLAN_EDIT_TOOLS.has(toolName)) {
    const path = [input.file_path, input.notebook_path, input.path, opts?.blockedPath].find(
      (v): v is string => typeof v === 'string',
    );
    if (path && isPlanFilePath(path)) {
      return { behavior: 'allow', updatedInput: input }; // (A) plan artifact
    }
    return {
      behavior: 'deny', // (C) read-only plan mode, no dialog → feedback instead of silent drop
      message:
        `Plan mode is read-only and this environment has no approval dialog, so "${toolName}"` +
        `${path ? ` on ${path}` : ''} can't run. Only writes under .claude/plans/ are allowed. ` +
        'Capture the intended changes in your plan instead of editing files now.',
    };
  }
  return { behavior: 'allow', updatedInput: input };
}

/** Build claude SDK options for one attempt. */
function buildClaudeOptions(ctx: RunCtx, independent: boolean): BuildSdkOptions {
  const { permissionMode } = ctx.params;
  const isPlan = permissionMode === 'plan';
  const model = resolveClaudeModel(ctx);
  const effort = resolveClaudeEffort(ctx);
  const settings = resolveClaudeSettings(ctx);
  return (abort, resume, isRetry) => ({
    // Independent task: resume is what makes the CLI load the transcript, so the first
    // attempt drops it and names the session explicitly instead — same file on disk, empty
    // context. A compaction retry still resumes: by then the only thing to reload IS this
    // turn (the history is stashed away), which is exactly what the retry needs.
    ...(independent && !isRetry
      ? { sessionId: resume }
      : resume && { resume }),
    ...(ctx.cwd && { cwd: ctx.cwd }),
    ...(model ? { model } : {}),
    ...(effort ? { effort } : {}),
    ...(settings ? { settings } : {}),
    settingSources: ['user', 'project', 'local'] as Array<'user' | 'project' | 'local'>,
    // Permission mode: 'plan' (read-only) when requested, else skip all permission checks.
    permissionMode: (isPlan ? 'plan' : 'bypassPermissions') as 'plan' | 'bypassPermissions',
    // allowDangerouslySkipPermissions only applies to bypassPermissions.
    ...(!isPlan && { allowDangerouslySkipPermissions: true as const }),
    // Plan mode: resolve every permission prompt here (see planPermission — no approval dialog
    // exists, so unresolved requests fail silently, which is what broke the plan-file write).
    ...(isPlan && {
      canUseTool: async (
        toolName: string,
        input: Record<string, unknown>,
        opts?: { blockedPath?: string },
      ) => planPermission(toolName, input, opts),
    }),
    includePartialMessages: true,
    abortController: abort,
    // env is ALWAYS passed: without it the SDK inherits process.env verbatim,
    // handing the agent this server's NODE_ENV=production. See sanitizedSpawnEnv.
    env: sanitizedSpawnEnv({}),
  });
}

export const claudeSpec: EngineSpec = {
  name: 'claude',
  runner: {
    async run(ctx) {
      const runCtx = withClaudePromptEffort(ctx);
      // "Independent task": run this turn with the transcript stashed, then merge it back.
      // A session with no transcript yet (ctx.sessionId unset) is already context-free, so
      // there is nothing to stash and the plain path applies.
      //
      // The stash MUST be undone before this method returns: the orchestrator calls
      // resolveTitle(cwd, sessionId) right after run() (orchestrator.ts), which reads this
      // very file — restoring later would let the independent turn's isolated content
      // retitle the whole session.
      const independent = runCtx.params.noHistory === true && !!runCtx.sessionId;
      if (!independent) {
        await runSdkLoop(runCtx, buildClaudeOptions(runCtx, false));
        return;
      }

      const sessionPath = getClaudeSessionPath(runCtx.cwd, runCtx.sessionId!);
      const stashed = stashTranscript(sessionPath);
      try {
        await runSdkLoop(runCtx, buildClaudeOptions(runCtx, true));
      } finally {
        if (stashed) mergeStashedTranscript(sessionPath);
      }
    },
    resolveTitle: (cwd, sessionId) => getSessionTitle(cwd, sessionId),
  },
};
