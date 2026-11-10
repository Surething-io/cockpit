/**
 * One-shot structured model call for decision-mode extraction (docs/DECISION_MODE.md §9, §12.3).
 *
 * Every adapter must leave NO trace and DO nothing:
 *   - Claude: Agent SDK with `persistSession: false` (no ~/.claude/projects entry,
 *     never in the session list) and `tools: []`.
 *   - Codex: app-server `ephemeral` thread in a `read-only` sandbox with
 *     `approvalPolicy: 'never'` (Codex cannot drop its shell; the sandbox stops writes).
 *   - DeepSeek / Kimi / GLM: one OpenAI-compatible chat completion, JSON mode.
 *   - Ollama: native /api/chat with `format` = the schema and an explicit
 *     `num_ctx`, or long input is silently cut from the front.
 * All run with an empty temp cwd so no project instructions are loaded.
 *
 * Subprocess / HTTP adapters are imperative (EFFECT.md §0 subprocess gateway);
 * `oneShotJson` is the Effect boundary.
 */
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { query } from '@anthropic-ai/claude-agent-sdk';
import { Effect } from 'effect';
import { AgentError, type AgentProvider } from '@cockpit/effect-core';
import { resolveOllamaConnection, sanitizedSpawnEnv } from '@cockpit/shared-utils';
import { CodexAppServerClient, type CodexNotification } from '../engines/codexAppServer/client';
import { readEngineEndpoints, type AnthropicCompatProvider } from '../engines/anthropicCompat';
import { deepseekProvider } from '../engines/deepseek';
import { kimiProvider } from '../engines/kimi';
import { glmProvider } from '../engines/glm';
import type { ExtractionEngine } from '@cockpit/feature-decisions/server';

export const EXTRACTION_ENGINES: ReadonlyArray<ExtractionEngine> = ['claude', 'codex', 'deepseek', 'kimi', 'glm', 'ollama'];

export interface OneShotRequest {
  engine: ExtractionEngine;
  model: string;
  system: string;
  prompt: string;
  schema: Record<string, unknown>;
  signal: AbortSignal;
}

const COMPAT: Record<'deepseek' | 'kimi' | 'glm', AnthropicCompatProvider> = { deepseek: deepseekProvider, kimi: kimiProvider, glm: glmProvider };

/** The text a model answered with → JSON. Tolerates a ```json fence around it. */
export function parseJsonAnswer(text: string): unknown {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return JSON.parse(fenced ? fenced[1] : t);
}

async function withTempCwd<A>(fn: (cwd: string) => Promise<A>): Promise<A> {
  const dir = await mkdtemp(join(tmpdir(), 'cockpit-extract-'));
  try {
    return await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

async function claudeOneShot(r: OneShotRequest): Promise<unknown> {
  return withTempCwd(async (cwd) => {
    const abortController = new AbortController();
    r.signal.addEventListener('abort', () => abortController.abort(), { once: true });
    const response = query({
      prompt: r.prompt,
      options: {
        model: r.model,
        cwd,
        systemPrompt: r.system,
        persistSession: false,
        tools: [],
        settingSources: [],
        outputFormat: { type: 'json_schema', schema: r.schema },
        permissionMode: 'bypassPermissions',
        allowDangerouslySkipPermissions: true,
        maxTurns: 4,
        abortController,
        env: sanitizedSpawnEnv({}),
      },
    });
    for await (const m of response) {
      if (m.type !== 'result') continue;
      if (m.subtype !== 'success') throw new Error(`claude: ${m.subtype}`);
      return m.structured_output ?? parseJsonAnswer(m.result);
    }
    throw new Error('claude: no result');
  });
}

async function codexOneShot(r: OneShotRequest): Promise<unknown> {
  return withTempCwd(async (cwd) => {
    let answer = '';
    let settle: { resolve: () => void; reject: (e: Error) => void } | null = null;
    const finished = new Promise<void>((resolve, reject) => (settle = { resolve, reject }));
    const onNotification = (n: CodexNotification) => {
      if (n.method === 'item/completed') {
        const item = n.params.item as { type?: string; text?: string } | undefined;
        if (item?.type === 'agentMessage' && typeof item.text === 'string') answer = item.text;
      } else if (n.method === 'turn/completed') {
        const turn = n.params.turn as { status?: string; error?: { message?: string } } | undefined;
        if (turn?.status === 'completed') settle?.resolve();
        else settle?.reject(new Error(`codex turn ${turn?.status ?? 'ended'}: ${turn?.error?.message ?? ''}`));
      } else if (n.method === 'error' && n.params.willRetry !== true) {
        const e = n.params.error as { message?: string } | undefined;
        settle?.reject(new Error(`codex: ${e?.message ?? 'error'}`));
      }
    };
    const client = CodexAppServerClient.start({
      env: sanitizedSpawnEnv({}),
      cwd,
      onNotification,
      onClosed: (e) => settle?.reject(e),
    });
    const abort = () => settle?.reject(new Error('aborted'));
    r.signal.addEventListener('abort', abort, { once: true });
    try {
      await client.request('initialize', { clientInfo: { name: 'cockpit', title: 'Cockpit', version: '1' }, capabilities: { experimentalApi: true } });
      client.notify('initialized');
      const opened = await client.request('thread/start', {
        model: r.model,
        cwd,
        sandbox: 'read-only',
        approvalPolicy: 'never',
        ephemeral: true,
        developerInstructions: r.system,
      });
      const threadId = (opened.thread as { id?: string } | undefined)?.id;
      if (!threadId) throw new Error('codex: no thread id');
      await client.request('turn/start', { threadId, input: [{ type: 'text', text: r.prompt }], outputSchema: r.schema, effort: 'low' });
      await finished;
      return parseJsonAnswer(answer);
    } finally {
      r.signal.removeEventListener('abort', abort);
      client.dispose();
      await Promise.race([client.exited, new Promise((res) => AbortSignal.timeout(3000).addEventListener('abort', res))]);
    }
  });
}

async function compatOneShot(engine: 'deepseek' | 'kimi' | 'glm', r: OneShotRequest): Promise<unknown> {
  const p = COMPAT[engine];
  const apiKey = await p.apiKey.read();
  if (!apiKey) throw new Error(`${p.label}: no API key configured`);
  const { openAiBaseUrl } = await readEngineEndpoints(p);
  const res = await fetch(`${openAiBaseUrl.replace(/\/$/, '')}/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: r.model,
      messages: [
        { role: 'system', content: `${r.system}\n\nAnswer with ONE JSON object matching this JSON Schema:\n${JSON.stringify(r.schema)}` },
        { role: 'user', content: r.prompt },
      ],
      response_format: { type: 'json_object' },
      ...(p.builtinTemperature === null ? {} : { temperature: 0 }),
    }),
    signal: r.signal,
  });
  if (!res.ok) throw new Error(`${p.label}: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { choices?: Array<{ message?: { content?: string } }> };
  return parseJsonAnswer(body.choices?.[0]?.message?.content ?? '');
}

/** The context window Ollama will actually use for `model` (configured / loaded), or null. */
export async function ollamaContextWindow(model: string, signal: AbortSignal): Promise<number | null> {
  const { baseUrl } = await resolveOllamaConnection();
  const base = baseUrl.replace(/\/v1\/?$/, '');
  const get = async (path: string, body?: unknown) => {
    const res = await fetch(`${base}${path}`, { method: body ? 'POST' : 'GET', headers: { 'Content-Type': 'application/json' }, ...(body ? { body: JSON.stringify(body) } : {}), signal });
    return res.ok ? ((await res.json()) as Record<string, unknown>) : {};
  };
  const ps = await get('/api/ps');
  const running = Array.isArray(ps.models) ? (ps.models as Array<{ name?: string; model?: string; context_length?: number }>).find((m) => m.name === model || m.model === model) : undefined;
  if (running?.context_length && running.context_length > 0) return running.context_length;
  const show = await get('/api/show', { model });
  const configured = Number(String(show.parameters ?? '').match(/(?:^|\n)num_ctx\s+(\d+)/)?.[1]);
  return configured > 0 ? configured : null;
}

/** Window used when Ollama reports none — small enough for any local model. */
export const OLLAMA_FALLBACK_CTX = 8192;

async function ollamaOneShot(r: OneShotRequest, numCtx: number): Promise<unknown> {
  const { baseUrl, apiKey } = await resolveOllamaConnection();
  const base = baseUrl.replace(/\/v1\/?$/, '');
  const res = await fetch(`${base}/api/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({
      model: r.model,
      stream: false,
      format: r.schema,
      think: false,
      options: { num_ctx: numCtx, temperature: 0 },
      messages: [
        { role: 'system', content: r.system },
        { role: 'user', content: r.prompt },
      ],
    }),
    signal: r.signal,
  });
  if (!res.ok) throw new Error(`ollama: HTTP ${res.status} ${(await res.text()).slice(0, 300)}`);
  const body = (await res.json()) as { message?: { content?: string } };
  return parseJsonAnswer(body.message?.content ?? '');
}

const PROVIDER: Record<ExtractionEngine, AgentProvider> = { claude: 'claude', codex: 'codex', deepseek: 'deepseek', kimi: 'kimi', glm: 'glm', ollama: 'ollama' };

export const oneShotJson = (r: OneShotRequest, numCtx: number): Effect.Effect<unknown, AgentError> =>
  Effect.tryPromise({
    try: () => {
      switch (r.engine) {
        case 'claude': return claudeOneShot(r);
        case 'codex': return codexOneShot(r);
        case 'ollama': return ollamaOneShot(r, numCtx);
        default: return compatOneShot(r.engine, r);
      }
    },
    catch: (cause) =>
      new AgentError({ provider: PROVIDER[r.engine], kind: r.signal.aborted ? 'timeout' : cause instanceof SyntaxError ? 'protocol' : 'unknown', cause }),
  });
