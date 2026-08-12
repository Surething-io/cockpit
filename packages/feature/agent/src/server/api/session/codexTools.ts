import type { ImageMediaType, MessageImage } from '@cockpit/shared-utils';

export const CODEX_IMAGE_ONLY_TEXT = '[Image]';

/**
 * Display names codex tools are normalized to. These are claude's vocabulary on
 * purpose: the client has no tool-name → renderer registry, it keys off these
 * exact strings (`ToolCallModal`'s TOOL_ICONS table and its
 * `name === 'Agent' || name === 'Task'` subagent check), so normalizing here is
 * what buys codex the existing bubbles and the subagent drill-in for free.
 *
 * Both the live engine (engines/codex.ts) and the resume parser
 * (api/session-by-path.ts) must go through this module — a name minted in only
 * one of them shows up as a different bubble before and after a refresh.
 */
export const CODEX_TOOL_NAMES = {
  bash: 'Bash',
  applyPatch: 'ApplyPatch',
  /** `spawn_agent` → claude's Task, so one bubble == one sub-agent. */
  task: 'Task',
  /** `update_plan` / live `todo_list` → the checklist MessageBubble already renders. */
  todo: 'TodoWrite',
  webSearch: 'WebSearch',
  webFetch: 'WebFetch',
} as const;

/**
 * codex namespaces MCP calls as `mcp__<server>` with the bare tool as the name, so
 * joining them yields claude's exact `mcp__<server>__<tool>` convention. Keeping that
 * spelling matters beyond cosmetics: `READ_ONLY_TOOLS` is a deny-list, so an MCP call
 * stays (correctly) classified as possibly-mutating under either engine.
 */
export const CODEX_MCP_NAMESPACE_PREFIX = 'mcp__';
export const codexMcpToolName = (server: string, tool: string): string =>
  `${CODEX_MCP_NAMESPACE_PREFIX}${server}__${tool}`;

/**
 * codex's multi-agent (`multi_agent_v1`) tool names. Only `spawn_agent` gets a
 * bubble: `wait_agent` merely completes the bubble its `spawn_agent` already
 * created (its per-agent report is that bubble's result), and the rest are
 * plumbing the user never needs to see.
 */
export const CODEX_SPAWN_FN_NAME = 'spawn_agent';
export const CODEX_WAIT_FN_NAME = 'wait_agent';
export const CODEX_AGENT_FN_NAMES: ReadonlySet<string> = new Set([
  CODEX_SPAWN_FN_NAME,
  CODEX_WAIT_FN_NAME,
  'close_agent',
  'send_input',
  'resume_agent',
]);

export const CODEX_PLAN_FN_NAME = 'update_plan';

/**
 * codex's file editor, persisted as a `custom_tool_call` (freeform body, not JSON
 * arguments).
 */
export const CODEX_PATCH_FN_NAME = 'apply_patch';

/**
 * From gpt-5.6 on, codex stops emitting one `function_call` per tool and routes
 * every action through a single freeform tool named `exec`, whose body is a small
 * JS script executed in codex's sandbox:
 *
 *   const r = await tools.exec_command({"cmd":"rg -n foo","workdir":"/repo"}); text(r.output);
 *   const patch = "*** Begin Patch\n…"; text(await tools.apply_patch(patch));
 *
 * So the tool identity now lives INSIDE the script, not in `payload.name`, and
 * both the resume parser and the live call_id reader have to look there — see
 * parseCodexExecScript.
 */
export const CODEX_EXEC_SCRIPT_FN_NAME = 'exec';

/** `custom_tool_call` names that become a bubble (both eras). */
export const CODEX_CUSTOM_TOOL_NAMES: ReadonlySet<string> = new Set([
  CODEX_PATCH_FN_NAME,
  CODEX_EXEC_SCRIPT_FN_NAME,
]);

export function normalizeCodexToolName(name: string, namespace?: string): string {
  // MCP first: the tool name alone (`js`) is meaningless without its server.
  if (namespace?.startsWith(CODEX_MCP_NAMESPACE_PREFIX)) return `${namespace}__${name}`;
  if (name === 'shell_command' || name === 'exec_command') return CODEX_TOOL_NAMES.bash;
  if (name === 'apply_patch') return CODEX_TOOL_NAMES.applyPatch;
  if (name === CODEX_SPAWN_FN_NAME) return CODEX_TOOL_NAMES.task;
  if (name === CODEX_PLAN_FN_NAME) return CODEX_TOOL_NAMES.todo;
  return name;
}

export interface CodexTodo { content: string; status: string }

/**
 * Plan → claude's TodoWrite input. Two encodings again, one per side: the rollout
 * stores `update_plan`'s arguments (`{plan:[{step,status}]}`, status `pending` |
 * `in_progress` | `completed`) while the live `todo_list` item carries
 * `[{text,completed}]`. MessageBubble's checklist counts `status === 'completed'`.
 */
export function parseCodexPlanInput(args: Record<string, unknown>): { todos: CodexTodo[] } {
  const plan = Array.isArray(args.plan) ? args.plan : [];
  return {
    todos: plan.flatMap((raw) => {
      const step = raw as { step?: unknown; status?: unknown };
      if (typeof step?.step !== 'string') return [];
      return [{
        content: step.step,
        status: typeof step.status === 'string' ? step.status : 'pending',
      }];
    }),
  };
}

/** Live-stream counterpart of parseCodexPlanInput (`todo_list.items`). */
export function codexTodoInput(
  items: Array<{ text?: string; completed?: boolean }> | undefined
): { todos: CodexTodo[] } {
  return {
    todos: (items ?? []).flatMap((i) =>
      typeof i?.text === 'string'
        ? [{ content: i.text, status: i.completed ? 'completed' : 'pending' }]
        : []
    ),
  };
}

/** Result text for a plan bubble — the tool returns nothing, but an empty result spins. */
export function codexTodoResultText(todos: CodexTodo[]): string {
  const done = todos.filter((t) => t.status === 'completed').length;
  return `${done}/${todos.length} completed`;
}

export interface CodexWebSearchAction {
  type?: string;
  query?: string;
  queries?: string[];
  url?: string;
}

/**
 * Map a web_search item onto claude's two web tools: a query is a WebSearch, an
 * opened page is a WebFetch. Both are in READ_ONLY_TOOLS and already have icons, so
 * this is purely a naming decision — codex exposes no result payload either way.
 */
export function codexWebSearchCall(
  query: string | undefined,
  action: CodexWebSearchAction | undefined
): { name: string; input: Record<string, unknown>; result: string } {
  if (action?.type === 'open_page' && action.url) {
    return { name: CODEX_TOOL_NAMES.webFetch, input: { url: action.url }, result: action.url };
  }
  const q = action?.query || query || '';
  const queries = action?.queries?.length ? action.queries : (q ? [q] : []);
  return {
    name: CODEX_TOOL_NAMES.webSearch,
    input: { query: q },
    // codex reports the queries it ran but never the hits; showing the queries beats
    // an empty result, which would leave the bubble looking unfinished.
    result: queries.join('\n'),
  };
}

/** Live MCP result: codex returns either a structured result or an error, never both. */
export function codexMcpResultText(item: {
  result?: unknown;
  error?: { message?: string } | null;
}): string {
  if (item.error?.message) return item.error.message;
  if (item.result === null || item.result === undefined) return '';
  return typeof item.result === 'string' ? item.result : JSON.stringify(item.result, null, 2);
}

/**
 * Parse an apply_patch body into a `{ changes: [{path, kind}] }` input, matching the
 * shape the live codex engine emits for `file_change` items so the bubble renders the
 * same way whether streamed live or rebuilt on resume.
 */
export function parseCodexPatchInput(input: string): { changes: Array<{ path: string; kind: string }> } {
  const changes: Array<{ path: string; kind: string }> = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    changes.push({ path: m[2].trim(), kind: m[1].toLowerCase() });
  }
  return { changes };
}

// ============================================
// gpt-5.6 `exec` script tool
// ============================================

/** String literals in an `exec` script. Template interpolation is not used by codex. */
const JS_STRING_LITERAL_RE = /"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g;

const JS_SIMPLE_ESCAPES: Record<string, string> = {
  n: '\n', r: '\r', t: '\t', b: '\b', f: '\f', v: '\v', '0': '\0',
};

function decodeJsStringLiteral(literal: string): string {
  if (literal.startsWith('"')) {
    try { return JSON.parse(literal) as string; } catch { /* fall through */ }
  }
  return literal.slice(1, -1).replace(
    /\\(u\{[0-9a-fA-F]+\}|u[0-9a-fA-F]{4}|x[0-9a-fA-F]{2}|[\s\S])/g,
    (_full, esc: string) => {
      if (esc.startsWith('u{')) return String.fromCodePoint(parseInt(esc.slice(2, -1), 16));
      if (esc.startsWith('u') || esc.startsWith('x')) return String.fromCharCode(parseInt(esc.slice(1), 16));
      return JS_SIMPLE_ESCAPES[esc] ?? esc;
    }
  );
}

/** The apply_patch body is bound to a variable, so it is found by content, not position. */
function extractPatchLiteral(script: string): string | null {
  JS_STRING_LITERAL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = JS_STRING_LITERAL_RE.exec(script))) {
    const value = decodeJsStringLiteral(m[0]);
    if (value.includes('*** Begin Patch')) return value;
  }
  return null;
}

/**
 * Slice the object literal passed to `tools.exec_command(` — brace-matched rather
 * than regex'd, because the JSON contains braces and quotes of its own.
 */
function extractExecArgs(script: string): Record<string, unknown> | null {
  const call = script.indexOf('tools.exec_command(');
  if (call === -1) return null;
  const open = script.indexOf('{', call);
  if (open === -1) return null;

  let depth = 0;
  let quote = '';
  for (let i = open; i < script.length; i++) {
    const ch = script[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { quote = ch; continue; }
    if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) {
      try {
        const parsed = JSON.parse(script.slice(open, i + 1)) as unknown;
        return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : null;
      } catch { return null; }
    }
  }
  return null;
}

export type CodexExecScript =
  | { kind: 'exec'; command: string; args: Record<string, unknown> }
  | { kind: 'patch'; patch: string }
  /** A script we could not classify — rendered raw so the call is never invisible. */
  | { kind: 'unknown' };

/** Classify an `exec` script body into the tool it actually invokes. */
export function parseCodexExecScript(script: string): CodexExecScript {
  const patch = extractPatchLiteral(script);
  if (patch) return { kind: 'patch', patch };

  const args = extractExecArgs(script);
  if (args) {
    return { kind: 'exec', command: typeof args.cmd === 'string' ? args.cmd : '', args };
  }
  return { kind: 'unknown' };
}

/** `exec` script → the same {name, input} pair the pre-5.6 function_calls produced. */
export function codexExecScriptCall(script: string): { name: string; input: Record<string, unknown> } {
  const parsed = parseCodexExecScript(script);
  if (parsed.kind === 'patch') {
    return { name: CODEX_TOOL_NAMES.applyPatch, input: parseCodexPatchInput(parsed.patch) };
  }
  if (parsed.kind === 'exec') {
    return {
      name: CODEX_TOOL_NAMES.bash,
      input: normalizeCodexToolInput('exec_command', parsed.args),
    };
  }
  // Unclassified: show the script itself in a Bash bubble. Wrong label beats a
  // silently missing tool call, which is exactly how the 5.6 format first broke.
  return { name: CODEX_TOOL_NAMES.bash, input: { command: script } };
}

/**
 * Tool output text. `function_call_output.output` is a plain string, but the 5.6
 * `custom_tool_call_output.output` is an array of content blocks
 * (`[{type:"input_text",text:"…"}, …]`) — stringifying that naively yields
 * `[object Object]` in the bubble.
 */
export function codexToolOutputText(output: unknown): string {
  if (output === null || output === undefined) return '';
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map(codexToolOutputText).join('');
  if (typeof output === 'object') {
    const text = (output as { text?: unknown }).text;
    if (typeof text === 'string') return text;
    return JSON.stringify(output);
  }
  return String(output);
}

/** Terminal sub-agent states — anything else means the agent is still working. */
const CODEX_AGENT_DONE = new Set(['completed', 'errored', 'interrupted', 'not_found', 'failed']);

export interface CodexAgentState {
  agentId: string;
  status: string;
  /** The sub-agent's final report (or the error text). */
  message: string;
  done: boolean;
}

/**
 * Build the Task bubble input from `spawn_agent`'s arguments. `description` is
 * what `ToolCallModal.getDisplayInfo()` renders as the bubble header, so it gets
 * filled with the agent nickname once known (see `codexSpawnDescription`).
 */
export function parseCodexSpawnInput(
  args: Record<string, unknown>,
  extra?: { nickname?: string; agentId?: string }
): Record<string, unknown> {
  const prompt = typeof args.message === 'string' ? args.message : '';
  const agentType = typeof args.agent_type === 'string' ? args.agent_type : undefined;
  return {
    ...(agentType ? { subagent_type: agentType } : {}),
    description: codexSpawnDescription(extra?.nickname, agentType, prompt),
    prompt,
    ...(extra?.agentId ? { agent_id: extra.agentId } : {}),
  };
}

/** Header label for a sub-agent bubble: "Turing (explorer)", else the prompt's first line. */
export function codexSpawnDescription(
  nickname: string | undefined,
  agentType: string | undefined,
  prompt: string
): string {
  if (nickname) return agentType ? `${nickname} (${agentType})` : nickname;
  const firstLine = prompt.split('\n', 1)[0]?.trim() || '';
  if (firstLine) return firstLine.slice(0, 80);
  return agentType || 'subagent';
}

/**
 * `spawn_agent`'s result — `{"agent_id":"019f…","nickname":"Turing"}`, stored as a
 * JSON *string* in the rollout. This is the only place the spawning call_id and the
 * sub-agent's own thread id are tied together, which is what the drill-in resolves.
 */
export function parseCodexSpawnOutput(output: string): { agentId: string; nickname?: string } | null {
  try {
    const parsed = JSON.parse(output) as { agent_id?: unknown; nickname?: unknown };
    if (typeof parsed?.agent_id !== 'string' || !parsed.agent_id) return null;
    return {
      agentId: parsed.agent_id,
      ...(typeof parsed.nickname === 'string' ? { nickname: parsed.nickname } : {}),
    };
  } catch {
    return null;
  }
}

/**
 * `wait_agent`'s result, as persisted in the rollout — an externally tagged enum:
 * `{"status":{"<agent_id>":{"completed":"<report>"}},"timed_out":false}`.
 *
 * NOTE this is a DIFFERENT shape from the live stream's `agents_states`
 * (`{"<agent_id>":{"status":"completed","message":"<report>"}}`, see
 * parseCodexAgentsStates). Same information, two encodings — codex serializes the
 * tool result and the thread-item event separately. Both are parsed into
 * CodexAgentState so live and resume produce identical bubbles.
 */
export function parseCodexWaitOutput(output: string): CodexAgentState[] {
  let parsed: { status?: Record<string, unknown> };
  try {
    parsed = JSON.parse(output) as { status?: Record<string, unknown> };
  } catch {
    return [];
  }
  const status = parsed?.status;
  if (!status || typeof status !== 'object') return [];

  const out: CodexAgentState[] = [];
  for (const [agentId, raw] of Object.entries(status)) {
    if (!raw || typeof raw !== 'object') continue;
    // Externally tagged: exactly one key, and it IS the status.
    const [tag, value] = Object.entries(raw as Record<string, unknown>)[0] ?? [];
    if (!tag) continue;
    out.push({
      agentId,
      status: tag,
      message: typeof value === 'string' ? value : '',
      done: CODEX_AGENT_DONE.has(tag),
    });
  }
  return out;
}

/** Live-stream counterpart of parseCodexWaitOutput (`collab_tool_call.agents_states`). */
export function parseCodexAgentsStates(
  states: Record<string, { status?: string; message?: string | null }> | undefined
): CodexAgentState[] {
  if (!states || typeof states !== 'object') return [];
  return Object.entries(states).flatMap(([agentId, raw]) => {
    const status = typeof raw?.status === 'string' ? raw.status : '';
    if (!status) return [];
    return [{
      agentId,
      status,
      message: typeof raw?.message === 'string' ? raw.message : '',
      done: CODEX_AGENT_DONE.has(status),
    }];
  });
}

/** Bubble result text for a finished sub-agent: its report, or why it produced none. */
export function codexAgentResultText(state: CodexAgentState): string {
  return state.message || `(agent ${state.status})`;
}

export function normalizeCodexToolInput(
  name: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (name === CODEX_SPAWN_FN_NAME) return parseCodexSpawnInput(input);
  if (name === CODEX_PLAN_FN_NAME) return parseCodexPlanInput(input);
  if (normalizeCodexToolName(name) !== CODEX_TOOL_NAMES.bash) return input;
  if (typeof input.command === 'string') return input;
  if (typeof input.cmd !== 'string') return input;

  const { cmd: _cmd, ...rest } = input;
  return { ...rest, command: input.cmd };
}

interface CodexContentBlock {
  type?: string;
  text?: string;
  image_url?: string;
}

const CODEX_IMAGE_TAG_RE = /^<image\b[^>]*>$/i;
const CODEX_IMAGE_MARKUP_RE = /<\/?image\b[^>]*>/gi;
const DATA_IMAGE_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]*)$/;

function parseCodexImageUrl(imageUrl: string): MessageImage | null {
  const match = imageUrl.match(DATA_IMAGE_URL_RE);
  if (!match) return null;

  return {
    type: 'base64',
    media_type: match[1] as ImageMediaType,
    data: match[2],
  };
}

export function extractCodexUserContent(content: CodexContentBlock[] | undefined): {
  text: string;
  images: MessageImage[];
} {
  const text = (content
    ?.filter(c => c.type === 'input_text' && c.text && !CODEX_IMAGE_TAG_RE.test(c.text.trim()))
    .map(c => c.text!)
    .join('') || '').replace(CODEX_IMAGE_MARKUP_RE, '');
  const images = content
    ?.filter(c => c.type === 'input_image' && c.image_url)
    .map(c => parseCodexImageUrl(c.image_url!))
    .filter((image): image is MessageImage => image !== null) || [];

  return { text, images };
}
