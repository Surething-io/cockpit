import * as fs from 'fs';
import * as readline from 'readline';
import { join } from 'path';
import { Effect } from 'effect';
import { resolveSessionPath } from './session/sessionStore';
import { findCodexSessionEntry } from '@cockpit/shared-utils';
import { handler, ok, parseJsonRaw } from '@cockpit/effect-runtime/server';
import {
  AppError,
  NotFoundError,
  ValidationError,
} from '@cockpit/effect-core';
import {
  CODEX_SPAWN_FN_NAME,
  codexAgentPathName,
  parseCodexSpawnOutput,
  parseCodexSubAgentActivity,
} from './session/codexTools';
import {
  parseCodexTranscriptFile,
  parseTranscriptFile,
} from './session/transcriptParsers';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// File fingerprint: mtime + size, lightweight check for file changes
function getFileFingerprint(filePath: string): string {
  const stat = fs.statSync(filePath);
  return `${stat.mtimeMs}-${stat.size}`;
}

interface SessionByPathBody {
  cwd?: string;
  sessionId?: string;
  // When set, return the transcript of the subagent spawned by this Agent/Task
  // tool call instead of the main session (new-format `<sessionId>/subagents/` dir).
  toolUseId?: string;
  // Workflow drill-in. When `workflowId` is set, return the workflow run journal
  // (`<sessionId>/workflows/<workflowId>.json`); when `workflowAgentId` is also
  // set, return that workflow subagent's transcript
  // (`<sessionId>/subagents/workflows/<workflowId>/agent-<workflowAgentId>.jsonl`).
  workflowId?: string;
  workflowAgentId?: string;
  limit?: number;
  beforeTurnIndex?: number;
  /**
   * Start the window AT this turn and run to the end. Used by the user-message
   * modal to pull an off-screen message back into view: unlike a client-computed
   * `limit`, it stays exact when the session grew since the index was read.
   */
  fromTurnIndex?: number;
  ifFingerprint?: string;
}

// Subagent meta sidecar (agent-<id>.meta.json next to agent-<id>.jsonl)
interface SubagentMeta {
  agentType?: string;
  description?: string;
  toolUseId?: string;
}

// One agent's progress entry inside a workflow run journal.
interface WorkflowAgentEntry {
  type?: string;
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

// Workflow run journal (`workflows/<runId>.json`). Only the fields the
// drill-in UI needs are typed; the raw file also carries `script`, `logs`,
// full `result`, etc. which we deliberately do NOT forward to the client.
interface WorkflowJournal {
  runId?: string;
  workflowName?: string;
  status?: string;
  durationMs?: number;
  agentCount?: number;
  totalTokens?: number;
  totalToolCalls?: number;
  startTime?: number;
  phases?: Array<{ title?: string; detail?: string }>;
  summary?: string;
  workflowProgress?: WorkflowAgentEntry[];
}

/**
 * Codex counterpart of findSubagentTranscript. Codex has no `subagents/` sidecar: a
 * sub-agent's transcript is an ordinary rollout of its own, in the shared
 * `~/.codex/sessions` tree, keyed by its thread id. The only link back to the
 * spawning call is inside the parent rollout, under the tool call's `call_id` — which
 * IS the tool_use id the client drilled in with. So: scan the parent for that id, then
 * resolve the child rollout by the agent id it names.
 *
 * Which line carries that link depends on the codex version (see codexTools):
 * `spawn_agent`'s function_call_output (`{"agent_id":…}`) on ≤ 0.14x, an
 * `event_msg`/`sub_agent_activity` (whose `event_id` is the call_id) on 0.147+. Both
 * are accepted — old rollouts stay drillable, and neither shape is guaranteed to be
 * the one this session was recorded with.
 */
async function findCodexSubagentTranscript(
  sessionPath: string,
  toolUseId: string
): Promise<{ transcriptPath: string; meta: SubagentMeta } | null> {
  const rl = readline.createInterface({
    input: fs.createReadStream(sessionPath),
    crlfDelay: Infinity,
  });

  let agentId: string | null = null;
  let agentType: string | undefined;
  try {
    for await (const line of rl) {
      if (!line.trim()) continue;
      let payload: {
        type?: string;
        name?: string;
        call_id?: string;
        arguments?: string;
        output?: string;
        event_id?: string;
        agent_thread_id?: string;
        agent_path?: string;
      } | undefined;
      try {
        payload = (JSON.parse(line) as { payload?: typeof payload }).payload;
      } catch { continue; }
      if (!payload) continue;

      // 0.147+: keyed by `event_id`, so this has to be tested before the call_id
      // filter below would drop the line.
      const activity = parseCodexSubAgentActivity(payload);
      if (activity) {
        if (activity.callId !== toolUseId) continue;
        agentId = activity.agentThreadId;
        if (!agentType && activity.agentPath) agentType = codexAgentPathName(activity.agentPath);
        break;
      }

      if (payload.call_id !== toolUseId) continue;

      if (payload.type === 'function_call' && payload.name === CODEX_SPAWN_FN_NAME) {
        try {
          const args = JSON.parse(payload.arguments || '{}') as {
            agent_type?: unknown;
            task_name?: unknown;
          };
          if (typeof args.agent_type === 'string') agentType = args.agent_type;
          else if (typeof args.task_name === 'string') agentType = codexAgentPathName(args.task_name);
        } catch { /* keep going: the linking line is what actually matters */ }
      } else if (payload.type === 'function_call_output') {
        const parsed = parseCodexSpawnOutput(payload.output || '');
        if (parsed) { agentId = parsed.agentId; break; }
        // 0.147+'s `{"task_name":…}` parses to null — the sub_agent_activity line
        // that follows carries the id, so keep scanning rather than give up here.
      }
    }
  } finally {
    rl.close();
  }

  if (!agentId) return null;
  const entry = findCodexSessionEntry(agentId);
  if (!entry || !fs.existsSync(entry.path)) return null;
  return {
    transcriptPath: entry.path,
    // The child's own session_meta is authoritative for role/nickname; fall back to
    // the spawn arguments when this rollout predates those fields.
    meta: {
      agentType: entry.agentRole || agentType,
      description: entry.agentNickname,
      toolUseId,
    },
  };
}

// Locate the subagent transcript spawned by a given tool_use id.
// Subagents live in `<sessionDir>/<sessionId>/subagents/agent-<id>.jsonl`
// with a meta sidecar carrying the spawning toolUseId.
function findSubagentTranscript(
  sessionPath: string,
  toolUseId: string
): { transcriptPath: string; meta: SubagentMeta } | null {
  const subagentsDir = join(sessionPath.replace(/\.jsonl$/, ''), 'subagents');
  if (!fs.existsSync(subagentsDir)) return null;
  for (const file of fs.readdirSync(subagentsDir)) {
    if (!file.endsWith('.meta.json')) continue;
    try {
      const meta = JSON.parse(
        fs.readFileSync(join(subagentsDir, file), 'utf-8')
      ) as SubagentMeta;
      if (meta.toolUseId !== toolUseId) continue;
      const transcriptPath = join(subagentsDir, file.replace(/\.meta\.json$/, '.jsonl'));
      if (fs.existsSync(transcriptPath)) return { transcriptPath, meta };
    } catch {
      // Skip unreadable meta files
    }
  }
  return null;
}

// Path of a workflow run journal: `<sessionDir>/workflows/<runId>.json`.
function workflowJournalPath(sessionPath: string, workflowId: string): string {
  return join(sessionPath.replace(/\.jsonl$/, ''), 'workflows', `${workflowId}.json`);
}

// Path of a single workflow subagent transcript:
// `<sessionDir>/subagents/workflows/<runId>/agent-<agentId>.jsonl`.
function workflowAgentTranscriptPath(
  sessionPath: string,
  workflowId: string,
  agentId: string
): string {
  return join(
    sessionPath.replace(/\.jsonl$/, ''),
    'subagents',
    'workflows',
    workflowId,
    `agent-${agentId}.jsonl`
  );
}

// Trim a raw journal down to the fields the drill-in UI renders. Drops
// `script`, `logs`, and the full `result` blob; keeps bounded previews only.
function trimWorkflowJournal(journal: WorkflowJournal) {
  const agents = (journal.workflowProgress ?? [])
    .filter((e) => e.type === 'workflow_agent')
    .map((e) => ({
      index: e.index,
      label: e.label,
      phaseIndex: e.phaseIndex,
      phaseTitle: e.phaseTitle,
      agentId: e.agentId,
      model: e.model,
      state: e.state,
      tokens: e.tokens,
      toolCalls: e.toolCalls,
      durationMs: e.durationMs,
      lastToolName: e.lastToolName,
      lastToolSummary: e.lastToolSummary,
      promptPreview: e.promptPreview,
      resultPreview: e.resultPreview,
    }));
  return {
    runId: journal.runId,
    workflowName: journal.workflowName,
    status: journal.status,
    durationMs: journal.durationMs,
    agentCount: journal.agentCount,
    totalTokens: journal.totalTokens,
    totalToolCalls: journal.totalToolCalls,
    startTime: journal.startTime,
    phases: journal.phases,
    summary: journal.summary,
    agents,
  };
}

export const POST = handler((req) =>
  Effect.gen(function* () {
    const body = (yield* parseJsonRaw(req)) as SessionByPathBody;
    const { cwd, sessionId, toolUseId, workflowId, workflowAgentId, limit, beforeTurnIndex, fromTurnIndex, ifFingerprint } = body;
    if (!cwd || !sessionId) {
      return yield* Effect.fail(
        new ValidationError({
          field: !cwd ? 'cwd' : 'sessionId',
          reason: 'missing',
        })
      );
    }

    // Resolve session file across 6 engines (claude/deepseek/codex/kimi/glm/ollama)
    const resolved = yield* Effect.sync(() => resolveSessionPath(cwd, sessionId));
    if (!resolved) {
      return yield* Effect.fail(
        new NotFoundError({ resource: 'session', id: sessionId })
      );
    }
    const { sessionPath, engine } = resolved;

    // Subagent transcript branch: same parser/fingerprint flow on the agent jsonl
    if (toolUseId) {
      if (!/^[A-Za-z0-9_-]+$/.test(toolUseId)) {
        return yield* Effect.fail(
          new ValidationError({ field: 'toolUseId', reason: 'invalid' })
        );
      }
      const sub = yield* engine === 'codex'
        ? Effect.tryPromise({
            try: () => findCodexSubagentTranscript(sessionPath, toolUseId),
            catch: (cause) =>
              new AppError({ message: 'findCodexSubagentTranscript failed', cause }),
          })
        : Effect.sync(() => findSubagentTranscript(sessionPath, toolUseId));
      if (!sub) {
        return yield* Effect.fail(
          new NotFoundError({ resource: 'subagent', id: toolUseId })
        );
      }
      const subFingerprint = getFileFingerprint(sub.transcriptPath);
      if (ifFingerprint && ifFingerprint === subFingerprint) {
        return ok({ notModified: true, fingerprint: subFingerprint });
      }
      // Same drill-in contract for both engines, each with its own transcript parser.
      const subResult = yield* Effect.tryPromise({
        try: () =>
          engine === 'codex'
            ? parseCodexTranscriptFile(sub.transcriptPath)
            : parseTranscriptFile(sub.transcriptPath),
        catch: (cause) =>
          new AppError({ message: 'parseTranscriptFile failed', cause }),
      });
      return ok({
        messages: subResult.messages,
        subagent: { agentType: sub.meta.agentType, description: sub.meta.description },
        fingerprint: subFingerprint,
      });
    }

    // Workflow drill-in branch: run journal, or a single workflow subagent's
    // transcript when workflowAgentId is also supplied. Both ids are
    // whitelisted to keep the file path inside the session dir.
    if (workflowId) {
      if (!/^wf_[A-Za-z0-9_-]+$/.test(workflowId)) {
        return yield* Effect.fail(
          new ValidationError({ field: 'workflowId', reason: 'invalid' })
        );
      }

      if (workflowAgentId) {
        if (!/^[A-Za-z0-9_-]+$/.test(workflowAgentId)) {
          return yield* Effect.fail(
            new ValidationError({ field: 'workflowAgentId', reason: 'invalid' })
          );
        }
        const agentPath = workflowAgentTranscriptPath(sessionPath, workflowId, workflowAgentId);
        if (!fs.existsSync(agentPath)) {
          return yield* Effect.fail(
            new NotFoundError({ resource: 'workflowAgent', id: workflowAgentId })
          );
        }
        const agentFingerprint = getFileFingerprint(agentPath);
        if (ifFingerprint && ifFingerprint === agentFingerprint) {
          return ok({ notModified: true, fingerprint: agentFingerprint });
        }
        const agentResult = yield* Effect.tryPromise({
          try: () => parseTranscriptFile(agentPath),
          catch: (cause) =>
            new AppError({ message: 'parseTranscriptFile failed', cause }),
        });
        return ok({ messages: agentResult.messages, fingerprint: agentFingerprint });
      }

      const journalPath = workflowJournalPath(sessionPath, workflowId);
      if (!fs.existsSync(journalPath)) {
        return yield* Effect.fail(
          new NotFoundError({ resource: 'workflow', id: workflowId })
        );
      }
      const journalFingerprint = getFileFingerprint(journalPath);
      if (ifFingerprint && ifFingerprint === journalFingerprint) {
        return ok({ notModified: true, fingerprint: journalFingerprint });
      }
      const workflow = yield* Effect.try({
        try: () =>
          trimWorkflowJournal(
            JSON.parse(fs.readFileSync(journalPath, 'utf-8')) as WorkflowJournal
          ),
        catch: (cause) =>
          new AppError({ message: 'readWorkflowJournal failed', cause }),
      });
      return ok({ workflow, fingerprint: journalFingerprint });
    }

    const fingerprint = getFileFingerprint(sessionPath);
    if (ifFingerprint && ifFingerprint === fingerprint) {
      return ok({ notModified: true, fingerprint });
    }

    const parseResult = yield* Effect.tryPromise({
      try: async () => {
        if (engine === 'codex') return parseCodexTranscriptFile(sessionPath);
        // Everything else (claude/ollama/deepseek/kimi/glm) writes Claude-style
        // transcripts, so one parser covers them.
        // ollama has done so since v1.0.186; the AI SDK ModelMessage legacy fallback
        // (v1.0.184–185 only) was removed.
        return parseTranscriptFile(sessionPath, { limit, beforeTurnIndex, fromTurnIndex });
      },
      catch: (cause) =>
        new AppError({ message: 'parseTranscriptFile failed', cause }),
    });

    const { messages, title, usage } = parseResult;
    const totalTurns = 'totalTurns' in parseResult ? parseResult.totalTurns : 0;
    const hasMore = 'hasMore' in parseResult ? parseResult.hasMore : false;
    // Index of the first returned turn, resolved server-side. Clients page further
    // back from this instead of inferring it by counting rendered user bubbles.
    const startTurnIndex = 'startTurnIndex' in parseResult ? parseResult.startTurnIndex : 0;
    return ok({
      messages,
      sessionId,
      title,
      usage,
      totalTurns,
      hasMore,
      startTurnIndex,
      fingerprint,
      // Authoritative engine for this session, resolved by file location across
      // all 7 engines. Clients use this to send on the session's native engine —
      // more reliable than the optional global-state engine field, which is only
      // written for sessions that were open as a tab.
      engine,
    });
  })
);
