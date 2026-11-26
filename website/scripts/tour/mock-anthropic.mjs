// A stand-in for the Anthropic Messages API, so the tour can show sessions that
// are really running — the real Claude CLI, the real Cockpit run state — without
// a model, a key, or nondeterministic output.
//
// Every request is answered from a script, slowly enough that the capture can
// photograph several sessions mid-run. A script is picked by a keyword in the
// opening message and is a list of steps: tool calls (read-only ones — the CLI
// really runs them against the demo project) and then the final text. The step
// to answer with is the number of tool results already in the conversation.
// After each turn the CLI also asks for a suggested next prompt; that gets the
// script's `suggestion` at once. Anything unmatched (title generation and the
// like) gets a short instant answer. Set TOUR_MOCK_LOG=<file> to log every request.
import { createServer } from 'http';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Text of the conversation's opening user message. Only that one: once a tool
 * has read a file, its contents are in the conversation too, and could match
 * another script's keyword.
 */
function openingText(body) {
  const first = (body.messages ?? []).find((m) => m.role === 'user');
  if (!first) return '';
  if (typeof first.content === 'string') return first.content;
  return first.content.filter((b) => b?.type === 'text').map((b) => b.text).join('\n');
}

/** The CLI's follow-up request for a suggested next prompt, sent after a turn ends. */
function isSuggestionRequest(body) {
  const last = body.messages?.at(-1)?.content;
  const text = typeof last === 'string' ? last : (last ?? []).map((b) => b?.text ?? '').join('');
  return text.includes('[SUGGESTION MODE');
}

function countToolResults(body) {
  let n = 0;
  for (const m of body.messages ?? []) {
    if (Array.isArray(m.content)) n += m.content.filter((b) => b?.type === 'tool_result').length;
  }
  return n;
}

/** Split text into word-sized chunks so it streams like a model would. */
function chunks(text) {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

/**
 * @typedef {{ tool: string, input: object, ms: number } | { text: string, ms: number }} Step
 * @param {{ port: number, replies: { match: RegExp, steps: Step[], suggestion?: string }[] }} opts
 *   `ms`: how long a step takes — the pause before a tool call, or the time a
 *   text step takes to stream in full.
 */
export function startMockAnthropic({ port, replies }) {
  const server = createServer(async (req, res) => {
    let raw = '';
    for await (const c of req) raw += c;
    const url = req.url || '';

    if (!url.startsWith('/v1/messages') || url.includes('count_tokens')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(url.includes('count_tokens') ? '{"input_tokens":1200}' : '{}');
      return;
    }

    let body = {};
    try {
      body = JSON.parse(raw);
    } catch {
      /* answer anyway */
    }
    const opening = openingText(body);
    // Only the main turn streams slowly; side calls (titles, summaries) carry a
    // system prompt of their own and no tools.
    const isMainTurn = Array.isArray(body.tools) && body.tools.length > 0;
    const hit = isMainTurn ? replies.find((r) => r.match.test(opening)) : undefined;
    const suggesting = isSuggestionRequest(body);
    const steps = suggesting
      ? [{ text: hit?.suggestion ?? '', ms: 0 }]
      : (hit?.steps ?? [{ text: 'OK.', ms: 0 }]);
    const step = suggesting ? steps[0] : steps[Math.min(countToolResults(body), steps.length - 1)];
    if (process.env.TOUR_MOCK_LOG) {
      const { appendFileSync } = await import('fs');
      appendFileSync(
        process.env.TOUR_MOCK_LOG,
        `${new Date().toISOString()} stream=${!!body.stream} tools=${body.tools?.length ?? 0} msgs=${body.messages?.length ?? 0} results=${countToolResults(body)} hit=${hit ? hit.match : '-'} step=${step.tool ?? 'text'} suggesting=${suggesting}\n`,
      );
    }
    const text = step.text ?? '';
    const ms = step.ms ?? 0;
    const model = body.model || 'claude-opus-5-5';
    const id = `msg_tour_${Math.random().toString(36).slice(2, 10)}`;
    const usage = { input_tokens: 1200, output_tokens: Math.ceil(text.length / 4) };

    if (!body.stream) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model, content: [{ type: 'text', text }], stop_reason: 'end_turn', stop_sequence: null, usage }));
      return;
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' });
    const send = (event, data) => res.write(`event: ${event}\ndata: ${JSON.stringify({ type: event, ...data })}\n\n`);
    send('message_start', { message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: { ...usage, output_tokens: 1 } } });

    if (step.tool) {
      await sleep(ms);
      if (res.destroyed) return;
      const toolId = `toolu_tour_${Math.random().toString(36).slice(2, 10)}`;
      send('content_block_start', { index: 0, content_block: { type: 'tool_use', id: toolId, name: step.tool, input: {} } });
      send('content_block_delta', { index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.input) } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 40 } });
      send('message_stop', {});
      res.end();
      return;
    }

    send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
    const parts = chunks(text);
    const pause = parts.length ? ms / parts.length : 0;
    for (const part of parts) {
      if (res.destroyed) return;
      send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: part } });
      if (pause) await sleep(pause);
    }
    send('content_block_stop', { index: 0 });
    send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: usage.output_tokens } });
    send('message_stop', {});
    res.end();
    if (hit && !suggesting) stats.finished += 1;
  });
  /** How many scripted conversations have streamed their final text. */
  const stats = { finished: 0 };
  server.stats = stats;
  return new Promise((resolve) => server.listen(port, '127.0.0.1', () => resolve(server)));
}
