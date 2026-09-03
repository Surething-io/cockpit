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
  /** `view_image` → claude's Read: it opens a file, and Read is in READ_ONLY_TOOLS. */
  read: 'Read',
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
  // Roster bookkeeping the model polls while waiting; its output is a status list,
  // never a result. The live stream has no event for it either, so leaving it out
  // of this set is what made a resumed turn grow a bare `list_agents` bubble that
  // was never there live.
  'list_agents',
]);

/**
 * codex 0.147 rewrote the multi-agent wire format, and every piece the sub-agent
 * bubble is built from moved. Both eras have to keep working — a rollout written by
 * either version is still on disk and still resumable:
 *
 *                     | ≤ 0.14x                          | 0.147+
 *   spawn arguments   | {message, agent_type?}           | {task_name, fork_turns, message}
 *   …message          | the prompt, in plain text        | a Fernet token (`gAAAAA…`)
 *   spawn output      | {agent_id, nickname}             | {task_name} — names no thread
 *   call_id ↔ thread  | that output                      | an `event_msg`/sub_agent_activity
 *   the report        | wait_agent's per-agent status    | a `response_item`/agent_message
 *
 * Losing the call_id ↔ thread id binding is what breaks the drill-in: it IS the link
 * from the Task bubble (keyed by the spawning call_id) to the sub-agent's own rollout.
 * It is also what routes the report back onto the bubble, so when it goes the Task row
 * never gets a result either — it reads as a sub-agent that started and never finished.
 *
 * That binding then moved a THIRD time in 0.153 (see
 * CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE). Treat "which line carries call_id ↔ thread id"
 * as the thing to re-verify on every codex SDK bump; codexTools.subagent.test.ts pins one
 * real line per era so the next move fails a test instead of a drill-in.
 */
export const CODEX_SUB_AGENT_ACTIVITY_TYPE = 'sub_agent_activity';
/**
 * 0.153 moved that line again — same fields, new envelope: it is now an `item_completed`
 * event wrapping an `item` of this type, with the call_id under `item.id` instead of
 * `event_id`. Nothing else about sub-agents changed, which is exactly why it was easy to
 * miss: the bump landed as part of an SDK upgrade and every OTHER codex surface kept working.
 * `parseCodexSubAgentActivity` reads both.
 */
export const CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE = 'SubAgentActivity';
export const CODEX_AGENT_MESSAGE_TYPE = 'agent_message';

export const CODEX_PLAN_FN_NAME = 'update_plan';

/** Opens an image file for the model. Its result is an image block, not text. */
export const CODEX_VIEW_IMAGE_FN_NAME = 'view_image';

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
  if (name === CODEX_VIEW_IMAGE_FN_NAME) return CODEX_TOOL_NAMES.read;
  // Everything else keeps its codex name on purpose. `wait` (await a background exec
  // cell) and `write_stdin` (feed a running shell) have no claude counterpart, and
  // renaming them to Bash would put a command in the header that was never run — a
  // raw name with a generic icon is uglier but true. NOTE `wait` is NOT the
  // multi-agent `wait_agent`; adding it to CODEX_AGENT_FN_NAMES would silently drop
  // a real tool call.
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
 * Minimal recursive-descent reader for the argument literal of
 * `tools.exec_command(...)`.
 *
 * Why not JSON.parse: what codex writes is a JavaScript object literal, not
 * JSON — its keys are BARE identifiers (`cmd:`, not `"cmd":`). JSON.parse
 * rejects that at the very first key, so EVERY exec script fell through to
 * `kind: 'unknown'`. Measured on a real rollout: 659 of 765 scripts unknown,
 * zero classified as exec. Three things broke off that one call:
 *   - the rollout's exec list stayed empty, so resolveCodexCallId never had a
 *     row to match and every Bash call fell back to the per-turn `item_N` id;
 *   - those snapshots lost their FileDiff after a refresh (the reload path
 *     keys on the rollout's `call_…`, which was never recorded);
 *   - a reloaded transcript rendered the raw JS wrapper instead of the command.
 *
 * Supported subset — everything codex emits: bare or quoted keys, all three JS
 * quote styles, numbers, true/false/null, nested objects/arrays, trailing
 * commas. Anything outside it returns null, which keeps the previous
 * behaviour (render the script raw) rather than guessing.
 */
interface JsCursor { readonly s: string; i: number }

const JS_IDENT_RE = /^[A-Za-z_$][A-Za-z0-9_$]*/;
const JS_SCALAR_RE = /^(-?\d[\d_]*(?:\.\d*)?(?:[eE][+-]?\d+)?|true|false|null|undefined)/;

const skipJsWs = (c: JsCursor): void => {
  while (c.i < c.s.length && /\s/.test(c.s[c.i])) c.i++;
};

/** Consumes one string literal; null = not a string, or unterminated. */
function readJsString(c: JsCursor): string | null {
  const q = c.s[c.i];
  if (q !== '"' && q !== "'" && q !== '`') return null;
  const start = c.i;
  c.i++;
  while (c.i < c.s.length) {
    const ch = c.s[c.i];
    if (ch === '\\') { c.i += 2; continue; }
    if (ch === q) { c.i++; return decodeJsStringLiteral(c.s.slice(start, c.i)); }
    c.i++;
  }
  return null;
}

/** Boxed so a legitimately-null/undefined value is distinguishable from failure. */
type JsRead = { v: unknown } | null;

function readJsValue(c: JsCursor): JsRead {
  skipJsWs(c);
  const ch = c.s[c.i];
  if (ch === undefined) return null;
  if (ch === '"' || ch === "'" || ch === '`') {
    const str = readJsString(c);
    return str === null ? null : { v: str };
  }
  if (ch === '{') return readJsObject(c);
  if (ch === '[') return readJsArray(c);
  const m = JS_SCALAR_RE.exec(c.s.slice(c.i));
  if (!m) return null;
  c.i += m[0].length;
  const raw = m[0];
  if (raw === 'true') return { v: true };
  if (raw === 'false') return { v: false };
  if (raw === 'null' || raw === 'undefined') return { v: null };
  const n = Number(raw.replace(/_/g, ''));
  return Number.isNaN(n) ? null : { v: n };
}

function readJsArray(c: JsCursor): JsRead {
  if (c.s[c.i] !== '[') return null;
  c.i++;
  const out: unknown[] = [];
  for (;;) {
    skipJsWs(c);
    if (c.s[c.i] === ']') { c.i++; return { v: out }; }
    if (c.i >= c.s.length) return null;
    const item = readJsValue(c);
    if (!item) return null;
    out.push(item.v);
    skipJsWs(c);
    if (c.s[c.i] === ',') { c.i++; continue; }
    if (c.s[c.i] === ']') { c.i++; return { v: out }; }
    return null;
  }
}

function readJsObject(c: JsCursor): JsRead {
  if (c.s[c.i] !== '{') return null;
  c.i++;
  const out: Record<string, unknown> = {};
  for (;;) {
    skipJsWs(c);
    if (c.s[c.i] === '}') { c.i++; return { v: out }; }
    if (c.i >= c.s.length) return null;
    // Key: quoted string, or the bare identifier JSON.parse used to choke on.
    let key: string | null = null;
    const ch = c.s[c.i];
    if (ch === '"' || ch === "'" || ch === '`') {
      key = readJsString(c);
    } else {
      const m = JS_IDENT_RE.exec(c.s.slice(c.i));
      if (m) { key = m[0]; c.i += m[0].length; }
    }
    if (key === null) return null;
    skipJsWs(c);
    if (c.s[c.i] !== ':') return null;
    c.i++;
    const val = readJsValue(c);
    if (!val) return null;
    out[key] = val.v;
    skipJsWs(c);
    if (c.s[c.i] === ',') { c.i++; continue; }
    if (c.s[c.i] === '}') { c.i++; return { v: out }; }
    return null;
  }
}

/** The object literal passed to `tools.<name>(` at `from`, or null. */
function readToolArgsAt(script: string, from: number): Record<string, unknown> | null {
  const open = script.indexOf('{', from);
  if (open === -1) return null;
  const read = readJsObject({ s: script, i: open });
  if (!read || !read.v || typeof read.v !== 'object') return null;
  return read.v as Record<string, unknown>;
}

/** The object literal passed to `tools.exec_command(`, or null if unparsable. */
function extractExecArgs(script: string): Record<string, unknown> | null {
  const call = script.indexOf('tools.exec_command(');
  if (call === -1) return null;
  return readToolArgsAt(script, call);
}

const TOOL_CALL_RE = /tools\.([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/g;

/**
 * The first `tools.<name>({…})` that is NOT exec_command/apply_patch — codex
 * routes its whole toolbox through the one `exec` freeform tool, so a script
 * body may be `write_stdin`, `update_plan`, … Recognizing them by name lets the
 * bubble carry the tool that actually ran; the alternative (the old `unknown`
 * fallback) mislabels them `Bash` and puts the raw JS wrapper in the command
 * header — a command that was never run, which normalizeCodexToolName's own
 * comment calls out as the thing not to do.
 */
function extractOtherToolCall(script: string): { tool: string; args: Record<string, unknown> } | null {
  TOOL_CALL_RE.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = TOOL_CALL_RE.exec(script))) {
    const tool = m[1];
    if (tool === 'exec_command' || tool === 'apply_patch') continue;
    const args = readToolArgsAt(script, m.index);
    if (args) return { tool, args };
  }
  return null;
}

export type CodexExecScript =
  | { kind: 'exec'; command: string; args: Record<string, unknown> }
  | { kind: 'patch'; patch: string }
  /**
   * Some other codex tool invoked through the same freeform `exec` tool
   * (`write_stdin`, `update_plan`, …). Deliberately NOT `exec`: it runs no
   * command line, so it gets no live `command_execution` item, and counting it
   * as one would shift every later exec index off its rollout call_id.
   */
  | { kind: 'other'; tool: string; args: Record<string, unknown> }
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
  const other = extractOtherToolCall(script);
  if (other) return { kind: 'other', tool: other.tool, args: other.args };
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
  if (parsed.kind === 'other') {
    // Same mapping the pre-5.6 function_call path uses, so a tool renders
    // identically whichever transport carried it.
    return {
      name: normalizeCodexToolName(parsed.tool),
      input: normalizeCodexToolInput(parsed.tool, parsed.args),
    };
  }
  // Unclassified: show the script itself in a Bash bubble. Wrong label beats a
  // silently missing tool call, which is exactly how the 5.6 format first broke.
  return { name: CODEX_TOOL_NAMES.bash, input: { command: script } };
}

/**
 * An image content block, as `view_image` returns it. Its `image_url` is a `data:`
 * URL of the whole file — locally these run to 586 KB each, ~6 MB across a few
 * sessions. It has no `text`, so the generic object branch below would inline that
 * base64 into the bubble as literal text: into the API response, into React state,
 * into the DOM. Hence its own branch, above the fallback.
 */
function isCodexImageBlock(block: object): boolean {
  const { type, image_url: url } = block as { type?: unknown; image_url?: unknown };
  return typeof url === 'string' || type === 'input_image' || type === 'output_image';
}

/**
 * Bound for the last-resort `JSON.stringify` below. Only that branch is capped —
 * a genuinely textual output (a build log) stays whole. This exists because the
 * unknown-tool fallback (parseCodexUnknownCall) now renders shapes nobody has
 * inspected: an unbounded blob would reach the bubble before anyone noticed.
 */
const CODEX_OUTPUT_STRINGIFY_LIMIT = 4000;

function stringifyBounded(value: unknown): string {
  const json = JSON.stringify(value) ?? '';
  if (json.length <= CODEX_OUTPUT_STRINGIFY_LIMIT) return json;
  return `${json.slice(0, CODEX_OUTPUT_STRINGIFY_LIMIT)}… (${json.length} chars truncated)`;
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
    if (isCodexImageBlock(output)) return CODEX_IMAGE_ONLY_TEXT;
    return stringifyBounded(output);
  }
  return String(output);
}

export interface CodexTokenUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

/**
 * Token usage from an `event_msg`/`token_count` line.
 *
 * The transcript parser used to read `response_completed.usage` instead — a line
 * codex does not write and, across 148 local rollouts spanning 0.94 → 0.147, never
 * has. That branch was dead, so a resumed codex session always reported no usage
 * at all.
 *
 * `last_token_usage` (this request) rather than `total_token_usage` (the session):
 * every request resends the whole conversation, so its `input_tokens` is the
 * context size — the same thing claude's per-message `usage` reports, which is what
 * the client's indicator is built for.
 */
export function parseCodexTokenUsage(payload: {
  type?: string;
  info?: unknown;
} | undefined | null): CodexTokenUsage | null {
  if (!payload || payload.type !== 'token_count') return null;
  const info = payload.info;
  if (!info || typeof info !== 'object') return null;
  const last = (info as { last_token_usage?: unknown }).last_token_usage;
  if (!last || typeof last !== 'object') return null;

  const raw = last as Record<string, unknown>;
  const num = (key: string): number | undefined =>
    typeof raw[key] === 'number' ? (raw[key] as number) : undefined;

  const usage: CodexTokenUsage = {
    ...(num('input_tokens') !== undefined ? { input_tokens: num('input_tokens') } : {}),
    ...(num('output_tokens') !== undefined ? { output_tokens: num('output_tokens') } : {}),
    // codex names the two cache halves differently from claude; the client only
    // knows claude's spelling.
    ...(num('cached_input_tokens') !== undefined
      ? { cache_read_input_tokens: num('cached_input_tokens') } : {}),
    ...(num('cache_write_input_tokens') !== undefined
      ? { cache_creation_input_tokens: num('cache_write_input_tokens') } : {}),
  };
  return Object.keys(usage).length > 0 ? usage : null;
}

/**
 * `response_item` payload types that already have a dedicated branch in the
 * transcript parser. Anything else there carrying a `call_id` is a tool call
 * cockpit has not been taught yet — see parseCodexUnknownCall.
 */
const CODEX_KNOWN_CALL_TYPES: ReadonlySet<string> = new Set([
  'function_call',
  'function_call_output',
  'custom_tool_call',
  'custom_tool_call_output',
]);

export interface CodexUnknownCall {
  callId: string;
  name: string;
  input: Record<string, unknown>;
}

/**
 * Generic fallback for a `response_item` shaped like a tool call whose type has no
 * branch of its own — `tool_search_call` / `tool_search_output` today, whatever
 * codex adds next tomorrow. Those two have been written since 0.141 and were
 * dropped on the floor the whole time, which is the argument for this existing:
 * a tool bubble under a raw type name is ugly, but a missing one is invisible, and
 * invisible is how every codex format break so far has been found — late, by a user.
 *
 * `call_id` is the discriminator, and the local corpus says it is a clean one:
 * across 148 rollouts every response_item type either always carries one
 * (function_call, custom_tool_call, tool_search_call) or never does (message,
 * reasoning, agent_message) — no type is mixed. The noisy duplicate projections
 * that also carry a call_id (`patch_apply_end` ×454, `mcp_tool_call_end`) are all
 * `event_msg` lines, which is why this is deliberately scoped to `response_item`.
 */
export function parseCodexUnknownCall(payload: {
  type?: string;
  name?: unknown;
  call_id?: unknown;
  arguments?: unknown;
  input?: unknown;
} | undefined | null): CodexUnknownCall | null {
  if (!payload || typeof payload.type !== 'string') return null;
  if (CODEX_KNOWN_CALL_TYPES.has(payload.type)) return null;
  const callId = typeof payload.call_id === 'string' ? payload.call_id : '';
  if (!callId) return null;
  return {
    callId,
    name: typeof payload.name === 'string' && payload.name ? payload.name : payload.type,
    input: unknownCallInput(payload),
  };
}

/**
 * `arguments` is a JSON *string* on a function_call but an already-decoded *object*
 * on a tool_search_call — an unknown tool may be either, so accept both.
 */
function unknownCallInput(payload: { arguments?: unknown; input?: unknown }): Record<string, unknown> {
  const args = payload.arguments;
  if (args && typeof args === 'object' && !Array.isArray(args)) {
    return args as Record<string, unknown>;
  }
  if (typeof args === 'string' && args.trim()) {
    try {
      const parsed = JSON.parse(args) as unknown;
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        return parsed as Record<string, unknown>;
      }
    } catch { /* fall through: show the raw arguments rather than nothing */ }
    return { arguments: args };
  }
  if (typeof payload.input === 'string' && payload.input) return { input: payload.input };
  return {};
}

/**
 * Result text for an unknown call's paired output line. Most carry `output`; the
 * ones that do not (tool_search_output puts its payload in `tools`) get the rest of
 * the line, minus the plumbing keys that are already the bubble's identity.
 */
export function codexUnknownCallResult(payload: Record<string, unknown>): string {
  if (payload.output !== undefined) return codexToolOutputText(payload.output);
  const { type: _t, id: _i, call_id: _c, ...rest } = payload;
  return Object.keys(rest).length > 0 ? stringifyBounded(rest) : '';
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
 *
 * On 0.147+ the dispatched task is NOT recoverable from disk: the spawn message is a
 * Fernet token, and the copy the sub-agent received (a NEW_TASK agent_message in its
 * own rollout) is the very same ciphertext. The key is the model provider's. So the
 * bubble reports the task as encrypted instead of carrying an empty `prompt`, which
 * would read as "cockpit lost it" — and an empty string is what every `prompt`
 * consumer already treats as absent anyway.
 */
export function parseCodexSpawnInput(
  args: Record<string, unknown>,
  extra?: { nickname?: string; agentId?: string }
): Record<string, unknown> {
  const message = typeof args.message === 'string' ? args.message : '';
  const encrypted = isCodexEncryptedPayload(message);
  const prompt = encrypted ? '' : message;
  const agentType = typeof args.agent_type === 'string'
    ? args.agent_type
    : typeof args.task_name === 'string'
      ? codexAgentPathName(args.task_name)
      : undefined;
  return {
    ...(agentType ? { subagent_type: agentType } : {}),
    description: codexSpawnDescription(extra?.nickname, agentType, prompt),
    ...(encrypted ? { message_encrypted: true } : { prompt }),
    ...(extra?.agentId ? { agent_id: extra.agentId } : {}),
  };
}

/**
 * codex's encrypted payloads (0.147+ spawn messages, reasoning blobs): a single
 * unbroken Fernet token. Matched on shape, not length, so a plain prompt that merely
 * happens to start with those characters still needs the no-whitespace, base64url-only
 * body to be misread — which a natural-language prompt never has.
 */
const CODEX_FERNET_TOKEN_RE = /^gAAAAA[A-Za-z0-9_-]{32,}={0,2}$/;

export function isCodexEncryptedPayload(text: string): boolean {
  return CODEX_FERNET_TOKEN_RE.test(text.trim());
}

/**
 * A codex agent path (`/root/cr_static`) → the task's own name (`cr_static`). The
 * path is how 0.147 identifies a sub-agent everywhere except its thread id: in the
 * spawn arguments (relative), in sub_agent_activity, and as an agent_message author.
 */
export function codexAgentPathName(agentPath: string): string {
  const segments = agentPath.split('/').filter(Boolean);
  return segments[segments.length - 1] || agentPath;
}

export interface CodexSubAgentActivity {
  /** The spawning `spawn_agent` call_id — i.e. the Task bubble's tool_use id. */
  callId: string;
  /** The sub-agent's thread id, which names its rollout file. */
  agentThreadId: string;
  /** Absolute agent path, e.g. `/root/cr_static`. */
  agentPath?: string;
  kind?: string;
}

/**
 * The sub-agent activity line — the only record tying a spawning call_id to the thread it
 * created, ever since `spawn_agent`'s output stopped naming one and returned just
 * `{"task_name":…}`.
 *
 * Two envelopes, both live on disk and both resumable:
 *
 *   0.147   {type:'sub_agent_activity', event_id, agent_thread_id, agent_path, kind}
 *   0.153+  {type:'item_completed', item:{type:'SubAgentActivity', id, agent_thread_id,
 *                                        agent_path, kind}}
 *
 * Same four fields; the call_id just moved from `event_id` to `item.id`. Normalised here so
 * the three call sites (live rollout reader, reload parser, drill-in lookup) stay era-blind.
 *
 * A `kind:'completed'` line is returned as-is even though its id is a synthetic
 * `subagent-completed-<uuid>` rather than a call_id: callers bind by looking the id up
 * among the spawn calls they have seen, where it simply never matches. Filtering on `kind`
 * here would instead bake in an assumption about which kinds exist.
 */
export function parseCodexSubAgentActivity(payload: {
  type?: string;
  event_id?: unknown;
  agent_thread_id?: unknown;
  agent_path?: unknown;
  kind?: unknown;
  item?: unknown;
} | undefined | null): CodexSubAgentActivity | null {
  if (!payload) return null;

  const item = payload.item as { type?: unknown; id?: unknown } | undefined;
  const src: { callId: unknown; agent_thread_id?: unknown; agent_path?: unknown; kind?: unknown } | null =
    payload.type === CODEX_SUB_AGENT_ACTIVITY_TYPE
      ? { ...payload, callId: payload.event_id }
      : item && item.type === CODEX_SUB_AGENT_ACTIVITY_ITEM_TYPE
        ? { ...(item as Record<string, unknown>), callId: item.id }
        : null;
  if (!src) return null;

  const { callId, agent_thread_id: agentThreadId } = src;
  if (typeof callId !== 'string' || !callId) return null;
  if (typeof agentThreadId !== 'string' || !agentThreadId) return null;
  return {
    callId,
    agentThreadId,
    ...(typeof src.agent_path === 'string' ? { agentPath: src.agent_path } : {}),
    ...(typeof src.kind === 'string' ? { kind: src.kind } : {}),
  };
}

export interface CodexAgentMessage {
  /** Sender agent path, e.g. `/root/cr_static`. */
  author: string;
  recipient?: string;
  /** The report body, envelope stripped. */
  text: string;
  /** False for interim chatter between agents; only a final answer completes a bubble. */
  final: boolean;
}

/**
 * A sub-agent's message to its parent (`response_item`/`agent_message`, 0.147+). This
 * is where the report lives now — `wait_agent` returns only `{"message":"Wait
 * completed.","timed_out":false}`. The body is wrapped in a fixed envelope:
 *
 *   Message Type: FINAL_ANSWER
 *   Task name: /root
 *   Sender: /root/cr_static
 *   Payload:
 *   <the actual report>
 *
 * An unrecognized envelope is passed through whole rather than dropped: a missing
 * header should cost formatting, not the report.
 */
export function parseCodexAgentMessage(payload: {
  type?: string;
  author?: unknown;
  recipient?: unknown;
  content?: unknown;
} | undefined | null): CodexAgentMessage | null {
  if (!payload || payload.type !== CODEX_AGENT_MESSAGE_TYPE) return null;
  const author = typeof payload.author === 'string' ? payload.author : '';
  if (!author) return null;

  const raw = Array.isArray(payload.content)
    ? (payload.content as Array<{ text?: unknown }>)
        .map((c) => (typeof c?.text === 'string' ? c.text : ''))
        .join('')
    : typeof payload.content === 'string' ? payload.content : '';

  const messageType = raw.match(/^Message Type:\s*(\S+)/m)?.[1];
  const payloadHeader = raw.match(/^Payload:[ \t]*$/m);
  let body = raw;
  if (payloadHeader?.index !== undefined) {
    const nl = raw.indexOf('\n', payloadHeader.index);
    if (nl !== -1) body = raw.slice(nl + 1);
  }

  return {
    author,
    ...(typeof payload.recipient === 'string' ? { recipient: payload.recipient } : {}),
    text: body.trim() || raw.trim(),
    final: !messageType || messageType === 'FINAL_ANSWER',
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
 * `spawn_agent`'s result on ≤ 0.14x — `{"agent_id":"019f…","nickname":"Turing"}`,
 * stored as a JSON *string* in the rollout, and back then the only place the spawning
 * call_id and the sub-agent's thread id were tied together.
 *
 * 0.147+ returns `{"task_name":"/root/cr_static"}` instead, naming no thread at all;
 * there the binding comes from parseCodexSubAgentActivity. Returning null for that
 * shape is correct, not a parse failure — callers must try both.
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
 *
 * 0.147+ carries no report here at all (`{"message":"Wait completed.","timed_out":
 * false}`), which yields an empty list — the report moved to an agent_message, see
 * parseCodexAgentMessage.
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
  // codex says `path`, claude's Read says `file_path` — and the header renderer
  // reads the latter.
  if (name === CODEX_VIEW_IMAGE_FN_NAME && typeof input.path === 'string') {
    const { path: _path, ...rest } = input;
    return { ...rest, file_path: input.path };
  }
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
