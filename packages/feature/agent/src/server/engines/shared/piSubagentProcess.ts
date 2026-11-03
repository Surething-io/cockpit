// Subprocess IPC boundary. Pi owns execution; the host collects bounded events.
import { spawn } from 'node:child_process';
import type { SubagentStop } from '../../../../../../../bin/pi-subagent-progress.mjs';
import type { AssistantMessage } from '@earendil-works/pi-ai';

export interface PiChildResult {
  output: string;
  error?: string;
  stopReason?: AssistantMessage['stopReason'];
  truncated?: boolean;
  needsHistoryFallback?: boolean;
  executionStop?: SubagentStop;
  usage: { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number; turns: number };
}
export interface PiChildProcess {
  closed: Promise<PiChildResult>;
  failed: Promise<void>;
  isClosed: () => boolean;
  cancel: () => void;
  terminate: () => void;
  kill: () => void;
}
const CAP = 50 * 1024;
const EVENT_CAP = 2 * 1024 * 1024;
const record = (value: unknown): Record<string, unknown> => {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('Expected an event object');
  return value as Record<string, unknown>;
};
const counter = (value: unknown, integral = true): number => {
  if (value === undefined) return 0;
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || integral && !Number.isSafeInteger(value)) throw new Error('Invalid usage counter');
  return value;
};
const stopReason = (value: unknown): AssistantMessage['stopReason'] => {
  if (value === 'stop' || value === 'length' || value === 'toolUse' || value === 'error' || value === 'aborted') return value;
  throw new Error('Invalid assistant stop reason');
};
interface FinalAssistant { text: string; stopReason: AssistantMessage['stopReason']; errorMessage?: string }

/** Normalize only consumed fields; no unvalidated JSON object reaches close. */
const assistant = (message: Record<string, unknown>, usage: PiChildResult['usage']): { last: FinalAssistant; usage: PiChildResult['usage'] } => {
  if (!Array.isArray(message.content)) throw new Error('Invalid assistant content');
  const texts: string[] = [];
  for (const part of message.content) {
    const block = record(part);
    if (typeof block.type !== 'string') throw new Error('Invalid assistant content block');
    if (block.type === 'text') {
      if (typeof block.text !== 'string') throw new Error('Invalid assistant text');
      texts.push(block.text);
    }
  }
  const reason = stopReason(message.stopReason);
  if (message.errorMessage !== undefined && typeof message.errorMessage !== 'string') throw new Error('Invalid assistant error message');
  const u = message.usage === undefined ? {} : record(message.usage);
  const cost = u.cost === undefined ? {} : record(u.cost);
  const next = {
    input: counter(usage.input + counter(u.input)), output: counter(usage.output + counter(u.output)),
    cacheRead: counter(usage.cacheRead + counter(u.cacheRead)), cacheWrite: counter(usage.cacheWrite + counter(u.cacheWrite)),
    cost: counter(usage.cost + counter(cost.total, false), false), turns: counter(usage.turns + 1),
  };
  return { last: { text: texts.join('\n'), stopReason: reason, errorMessage: message.errorMessage }, usage: next };
};

/** With a prompt, use native RPC: abort waits for idle, then stdin EOF shuts down. */
export function startPiChild(
  entry: string, args: string[], cwd: string, env: NodeJS.ProcessEnv,
  update: (text: string) => void, prompt?: string,
): PiChildProcess {
  const child = spawn(process.execPath, [entry, ...args], { cwd, env, shell: false, stdio: ['pipe', 'pipe', 'pipe'] });
  const rpc = prompt !== undefined;
  let done = false, cancelRequested = false, promptAccepted = false, abortSent = false;
  let buffer = '', stderr = '', error: string | undefined;
  let discardLine = false, protocolTruncated = false;
  let last: FinalAssistant | undefined;
  let executionStop: SubagentStop | undefined;
  let pending = '', pendingLength = 0, activeAssistant = false, pendingChars = 0;
  let reportFailure!: () => void;
  const failed = new Promise<void>((resolve) => { reportFailure = resolve; });
  const usage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 0 };
  const stop = (signal: NodeJS.Signals) => { if (!done) child.kill(signal); };
  const send = (command: object) => { if (!done && !child.stdin.writableEnded && !child.stdin.destroyed) child.stdin.write(JSON.stringify(command) + '\n'); };
  const abort = () => {
    if (promptAccepted && !abortSent) { abortSent = true; send({ type: 'abort', id: 'cockpit-abort' }); }
  };
  const cancel = () => {
    cancelRequested = true;
    if (rpc) abort(); else stop('SIGTERM');
  };
  const invalid = (message: string, truncated = false) => {
    error ??= message;
    protocolTruncated ||= truncated;
    // Wake the Effect owner even when the process stays alive. Only that owner
    // performs bounded shutdown; reporting a failure does not imply exit.
    reportFailure();
  };
  const line = (text: string) => {
    if (!text.trim()) return;
    if (text.length > EVENT_CAP) { invalid('Pi JSON event exceeded 2 MiB', true); return; }
    try {
      const event = record(JSON.parse(text));
      if (typeof event.type !== 'string') throw new Error('Invalid event type');
      if (event.type === 'entry_appended') {
        const entry = record(event.entry);
        if (entry.customType === 'cockpit.execution-stop') {
          const data = record(entry.type === 'custom_message' ? entry.details : entry.data);
          if (data.reason !== 'no_progress' || typeof data.summary !== 'string') throw new Error('Invalid child progress stop');
          executionStop ??= { reason: 'no_progress', summary: data.summary };
          error ??= `Pi subagent stopped: no_progress. Partial work and native history are retained.\n${data.summary}`;
          update(error);
          // A native abort can race with a newly started compaction request.
          // Wake the existing Effect owner so this child still exits within bounds.
          reportFailure();
        } else if (entry.customType === 'cockpit.execution-notice' && typeof entry.content === 'string') update(entry.content);
      }
      if (rpc && event.type === 'response') {
        if (typeof event.success !== 'boolean' || typeof event.command !== 'string' || event.id !== undefined && typeof event.id !== 'string') throw new Error('Invalid RPC response');
        if (event.success === false && typeof event.error !== 'string') throw new Error('Invalid RPC error');
        if (event.success === false) invalid(`Pi RPC ${event.command} failed: ${event.error}`);
        else if (event.id === 'cockpit-prompt') { promptAccepted = true; if (cancelRequested) abort(); }
        else if (event.id === 'cockpit-abort') child.stdin.end();
      } else if (rpc && event.type === 'agent_settled' && !cancelRequested) child.stdin.end();
      else if (event.type === 'message_start' || event.type === 'message_end') {
        const message = record(event.message);
        if (typeof message.role !== 'string') throw new Error('Invalid message role');
        if (message.role !== 'assistant') return;
        if (event.type === 'message_start') {
          pending = ''; pendingLength = 0; pendingChars = 0; activeAssistant = true;
        } else {
          // Validate the entire consumed snapshot and totals before committing
          // any state, so malformed endings cannot erase current partial text.
          const validated = assistant(message, usage);
          last = validated.last;
          Object.assign(usage, validated.usage);
          activeAssistant = false;
          update(last.text.slice(-2000) || pending.slice(-2000));
        }
      } else if (event.type === 'tool_execution_start') {
        if (typeof event.toolName !== 'string') throw new Error('Invalid tool name');
        update(`Tool: ${event.toolName}`);
      } else if (event.type === 'message_update') {
        const deltaEvent = record(event.assistantMessageEvent);
        if (typeof deltaEvent.type !== 'string') throw new Error('Invalid assistant delta event');
        if (deltaEvent.type !== 'text_delta') return;
        const delta = deltaEvent.delta;
        if (typeof delta !== 'string') throw new Error('Invalid text delta');
        const first = pendingLength === 0;
        activeAssistant = true;
        pendingLength += delta.length;
        pending = (pending + delta).slice(0, CAP);
        pendingChars += delta.length;
        if (first || pendingChars >= 200) { update(pending.slice(-2000)); pendingChars = 0; }
      }
    } catch (cause) { invalid(`Invalid Pi JSON event: ${cause instanceof Error ? cause.message : String(cause)}`); }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    buffer += chunk;
    let newline: number;
    while ((newline = buffer.indexOf('\n')) >= 0) {
      if (!discardLine) line(buffer.slice(0, newline));
      discardLine = false; buffer = buffer.slice(newline + 1);
    }
    if (buffer.length > EVENT_CAP) {
      invalid('Pi JSON event exceeded 2 MiB', true); buffer = ''; discardLine = true;
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => { stderr = (stderr + chunk).slice(-16384); });
  child.stdin.on('error', (cause) => { if (!done) invalid(`Pi RPC input failed: ${cause.message}`); });
  const closed = new Promise<PiChildResult>((resolve) => {
    child.on('error', (cause) => invalid(cause.message));
    child.on('close', (code, signal) => {
      done = true;
      try {
        if (!discardLine && buffer.trim()) line(buffer);
        const finalText = last?.text ?? '';
        const usePending = !!pending && (activeAssistant || !finalText && last?.stopReason !== 'stop');
        const text = usePending ? pending : finalText;
        const hostTruncated = (usePending ? pendingLength : finalText.length) > CAP;
        const incomplete = cancelRequested || activeAssistant || code !== 0 || signal || last?.stopReason !== 'stop'
          ? [`Pi subagent incomplete (stopReason=${activeAssistant ? 'missing' : last?.stopReason ?? 'missing'}; exitCode=${code}; signal=${signal ?? 'none'}).${last?.stopReason === 'length' ? ' Output was truncated; partial output is retained.' : ''}`, last?.errorMessage, stderr].filter(Boolean).join('\n') : undefined;
        resolve({ output: text.slice(0, CAP), usage, executionStop, stopReason: activeAssistant ? undefined : last?.stopReason,
          truncated: protocolTruncated || hostTruncated || last?.stopReason === 'length', needsHistoryFallback: usePending,
          error: [error, incomplete, hostTruncated ? `Pi subagent exceeded the host output limit (${CAP} characters). Partial output is retained; open the native child history for the full recorded result.` : undefined].filter(Boolean).join('\n') || undefined });
      } catch (cause) {
        // No exception may escape an EventEmitter close callback. Settle even
        // if an unexpected finalization defect occurs, retaining safe text.
        invalid(`Pi child finalization failed: ${cause instanceof Error ? cause.message : String(cause)}`);
        resolve({ output: pending || last?.text.slice(0, CAP) || '', usage, error,
          truncated: protocolTruncated || pendingLength > CAP,
          needsHistoryFallback: !!pending });
      }
    });
  });
  if (rpc) send({ type: 'prompt', id: 'cockpit-prompt', message: prompt });
  else child.stdin.end();
  return { closed, failed, isClosed: () => done, cancel, terminate: () => stop('SIGTERM'), kill: () => stop('SIGKILL') };
}
