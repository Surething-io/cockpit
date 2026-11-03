// Pi child-local progress detection; the native SDK owns transport and usage.
import { createHash } from 'node:crypto';

export const GUARD_NOTICE = 'cockpit.execution-notice';
export const GUARD_STOP = 'cockpit.execution-stop';
// Retain the existing thresholds explicitly; no request or token limits.
export const REPEAT_COUNT = 3;
export const MAX_CYCLE = 8;
const canonical = (value) => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]])) : item);
const fingerprint = (value) => createHash('sha256').update(canonical(value)).digest('hex');

export function createSubagentProgressGuard() {
  const recent = [];
  // The warning allowance belongs to the whole execution, not a particular command.
  let warned = false, correctionPending = false;
  const warnedPatterns = new Set();
  return {
    observe(message, results) {
      if (message.role !== 'assistant') return;
      const calls = message.content.filter((part) => part.type === 'toolCall');
      if (!calls.length || results.length !== calls.length) { recent.length = 0; correctionPending = false; warnedPatterns.clear(); return; }
      const round = calls.map((call) => {
        const result = results.find((item) => item.toolCallId === call.id);
        return result ? { name: call.name, arguments: call.arguments, content: result.content, isError: result.isError } : null;
      });
      if (round.includes(null)) { recent.length = 0; return; }
      const signature = fingerprint(round);
      recent.push(signature);
      if (recent.length > MAX_CYCLE * REPEAT_COUNT) recent.shift();
      // Repeating the already warned cycle gets no fresh multi-round allowance.
      const repeatsWarning = correctionPending && warnedPatterns.has(signature);
      correctionPending = false;
      let cycle = 0;
      for (let size = 1; size <= MAX_CYCLE && size * REPEAT_COUNT <= recent.length; size++) {
        if (Array.from({ length: size * (REPEAT_COUNT - 1) }, (_, i) => recent[recent.length - 1 - i] === recent[recent.length - 1 - i - size]).every(Boolean)) { cycle = size; break; }
      }
      if (!cycle && !repeatsWarning) return;
      const action = warned ? 'stop' : 'warn';
      warned = true;
      correctionPending = action === 'warn';
      for (const item of recent.slice(-cycle)) warnedPatterns.add(item);
      const summary = calls.map((call) => `${call.name} ${canonical(call.arguments).slice(0, 600)}`).join('\n').slice(0, 2000);
      return { action, reason: 'no_progress', cycle: cycle || 1, summary };
    },
  };
}


/** Loaded explicitly in each CLI child, never in the embedded parent. */
export default function subagentProgress(pi) {
  const guard = createSubagentProgressGuard();
  let stopped = false;
  const notice = (customType, text, details) => ({ type: 'custom_message', customType, content: text, display: true, details });
  pi.on('turn_start', (_event, ctx) => { if (stopped) ctx.abort(); });
  pi.on('turn_end', (event, ctx) => {
    if (stopped) return;
    const decision = guard.observe(event.message, event.toolResults);
    if (!decision) return;
    if (decision.action === 'stop') {
      stopped = true;
      ctx.abort();
      return { entries: [notice(GUARD_STOP,
        `Execution stopped: no_progress. Partial work and native history are retained.\n${decision.summary}`,
        { reason: 'no_progress', summary: decision.summary })] };
    }
    return { entries: [notice(GUARD_NOTICE,
      `Execution notice: The same tool calls have repeatedly returned identical results. These results are already available in context.\n${decision.summary}\nUse the existing results, choose a different approach, or finish with an explanation of what prevents further progress. Continuing the same cycle will stop this task.`, decision)] };
  });
}
