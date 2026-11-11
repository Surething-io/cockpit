import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdir, mkdtemp, readdir, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Effect } from 'effect';
import type { ContextSnapshot } from '../../shared/contextSnapshot';

// Data dirs are resolved at import time, so isolate them before importing.
let root: string;
let shared: typeof import('./contextShared');
let codex: typeof import('./codexContext');
let pi: typeof import('./piContext');
let grok: typeof import('./grokContext');
let claude: typeof import('./claudeContext');
let store: typeof import('./claudeContextStore');
const oldHome = process.env.COCKPIT_HOME;

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), 'cockpit-context-'));
  process.env.COCKPIT_HOME = join(root, 'cockpit');
  vi.stubEnv('GROK_HOME', join(root, 'grok'));
  shared = await import('./contextShared');
  codex = await import('./codexContext');
  pi = await import('./piContext');
  grok = await import('./grokContext');
  claude = await import('./claudeContext');
  store = await import('./claudeContextStore');
});
afterAll(async () => {
  vi.unstubAllEnvs();
  if (oldHome === undefined) delete process.env.COCKPIT_HOME;
  else process.env.COCKPIT_HOME = oldHome;
  await rm(root, { recursive: true, force: true });
});

const jsonl = (records: unknown[]) => records.map((r) => JSON.stringify(r)).join('\n') + '\n';
const category = (snap: ContextSnapshot, id: string) => snap.categories.find((c) => c.id === id);
const labels = (snap: ContextSnapshot, id: string) => category(snap, id)?.items.map((i) => i.label) ?? [];

describe('readLinesFromLastMatch', () => {
  it('returns lines from the last match across chunk boundaries, keeping multibyte text intact', async () => {
    const path = join(root, 'tail.jsonl');
    const filler = '中'.repeat(400_000); // > 1 MB of 3-byte chars forces several backward chunks
    await writeFile(path, ['a', 'MARK 1', filler, 'MARK 2', `x${filler}`, 'z'].join('\n') + '\n');
    const lines = await Effect.runPromise(shared.readLinesFromLastMatch(path, (l) => l.startsWith('MARK')));
    expect(lines.map((l) => l.slice(0, 6))).toEqual(['MARK 2', `x${'中'.repeat(5)}`, 'z']);
    expect(lines[1]).toBe(`x${filler}`);
  });

  it('offers the first line of the file to the predicate too', async () => {
    const path = join(root, 'first.jsonl');
    await writeFile(path, 'first\nsecond\n');
    const seen: string[] = [];
    await Effect.runPromise(shared.readLinesFromLastMatch(path, (l) => { seen.push(l); return false; }));
    expect(seen).toEqual(['second', 'first']);
  });

  it('returns the whole file when nothing matches', async () => {
    const path = join(root, 'nomatch.jsonl');
    await writeFile(path, 'one\ntwo');
    expect(await Effect.runPromise(shared.readLinesFromLastMatch(path, () => false))).toEqual(['one', 'two']);
  });
});

describe('codex context', () => {
  const item = (payload: unknown) => ({ timestamp: '2026-11-10T00:00:00Z', type: 'response_item', payload });
  const msg = (role: string, text: string) => item({ type: 'message', role, content: [{ type: 'input_text', text }] });

  it('rebuilds the last compaction plus later items and reports the provider total', async () => {
    const path = join(root, 'rollout.jsonl');
    await writeFile(path, jsonl([
      { timestamp: 't0', type: 'session_meta', payload: { id: 's', base_instructions: { text: 'BASE PROMPT' } } },
      msg('user', 'dropped by compaction'),
      { timestamp: 't1', type: 'compacted', payload: { message: '', replacement_history: [
        { type: 'additional_tools', tools: [{ type: 'namespace', name: 'functions', tools: [] }] },
        { type: 'message', role: 'developer', content: [{ type: 'input_text', text: '<skills_instructions>\n## Skills' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: '# AGENTS.md instructions for /repo\n\nbe nice' }] },
        { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kept user turn' }] },
        { type: 'compaction', encrypted_content: 'gAAA' },
      ] } },
      { timestamp: 't2', type: 'turn_context', payload: { model: 'gpt-x' } },
      msg('user', '<environment_context>\n<cwd>/repo</cwd>'),
      item({ type: 'custom_tool_call', call_id: 'c1', name: 'exec', input: 'ls' }),
      item({ type: 'custom_tool_call_output', call_id: 'c1', output: [{ type: 'input_text', text: 'file.txt' }] }),
      { timestamp: 't3', type: 'event_msg', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 900, output_tokens: 100 }, model_context_window: 2000 } } },
    ]));
    const snap = await Effect.runPromise(codex.buildCodexContext(path));
    expect(snap).toMatchObject({ engine: 'codex', model: 'gpt-x', usedTokens: 1000, contextWindow: 2000, capturedAt: 't3' });
    expect(labels(snap, 'system')).toEqual(['base instructions']);
    expect(labels(snap, 'memory')).toEqual(['AGENTS.md · /repo']);
    expect(labels(snap, 'skills')).toEqual(['skills_instructions']);
    expect(labels(snap, 'tools')).toEqual(['functions']);
    expect(labels(snap, 'environment')).toEqual(['environment_context']);
    expect(labels(snap, 'tool_io')).toEqual(['→ exec', '← exec']);
    expect(category(snap, 'messages')?.items.map((i) => i.content)).toEqual(['kept user turn']);
    expect(category(snap, 'summary')?.items[0]).toMatchObject({ tokens: null });
    expect(snap.notes).toEqual(expect.arrayContaining(['after_compaction', 'reasoning_encrypted']));
  });

  const started = { type: 'event_msg', payload: { type: 'task_started' } };
  const fullState = { type: 'world_state', payload: { full: true, state: {} } };
  const incState = { type: 'world_state', payload: { full: false, state: {} } };

  it('counts only the latest independent turn when noHistory turns were appended back', async () => {
    const path = join(root, 'nohistory.jsonl');
    const turn = (n: number) => [
      started, msg('developer', '<skills_instructions>\nlisting'), fullState, msg('user', `task ${n}`),
    ];
    await writeFile(path, jsonl([
      { type: 'session_meta', payload: { id: 's' } },
      ...turn(1), ...turn(2),
      // A normal follow-up turn keeps history: incremental state, no reset.
      started, incState, msg('user', 'follow-up'),
    ]));
    const snap = await Effect.runPromise(codex.buildCodexContext(path));
    expect(category(snap, 'skills')?.items).toHaveLength(1);
    expect(category(snap, 'messages')?.items.map((i) => i.content)).toEqual(['task 2', 'follow-up']);
  });

  it('keeps the compaction as the start when its own full world_state follows it', async () => {
    const path = join(root, 'compact-full.jsonl');
    await writeFile(path, jsonl([
      started, msg('user', 'before'),
      { type: 'compacted', payload: { replacement_history: [{ type: 'message', role: 'user', content: [{ type: 'input_text', text: 'kept' }] }] } },
      fullState, msg('user', 'after'),
    ]));
    const snap = await Effect.runPromise(codex.buildCodexContext(path));
    expect(category(snap, 'messages')?.items.map((i) => i.content)).toEqual(['kept', 'after']);
  });

  it('does not count base instructions twice when history already echoes them', async () => {
    const path = join(root, 'echo.jsonl');
    await writeFile(path, jsonl([
      { type: 'session_meta', payload: { base_instructions: { text: 'You are Codex, base' } } },
      msg('developer', 'You are Codex, base'),
    ]));
    const snap = await Effect.runPromise(codex.buildCodexContext(path));
    expect(category(snap, 'system')?.items).toHaveLength(1);
    expect(snap.usedTokens).toBeNull();
    expect(snap.notes).toContain('usage_unknown');
  });
});

describe('pi context', () => {
  it('splits system sections, memory files and tools, and uses the last non-empty usage', () => {
    const snap = pi.piContextFromMessages([
      { role: 'system', content: '', sections: {
        preamble: 'You are pi',
        project_context: '<project_context>\nProject-specific instructions and guidelines:\n\n<project_instructions path="/repo/AGENTS.md">\nrules here\n</project_instructions>\n</project_context>',
        skills: '<skills>listing</skills>',
        cwd: '<cwd>/repo</cwd>',
      }, toolsAdded: [{ name: 'read', parameters: {} }, { name: 'bash' }] },
      { role: 'user', content: 'hello' },
      { role: 'assistant', content: [{ type: 'thinking', thinking: 'hmm' }, { type: 'text', text: 'hi' }, { type: 'toolCall', name: 'bash', arguments: { cmd: 'ls' } }],
        usage: { input: 10, cacheRead: 90, cacheWrite: 0, output: 5 }, timestamp: 1_800_000_000_000 },
      { role: 'toolResult', toolName: 'bash', content: [{ type: 'text', text: 'out' }] },
      { role: 'system', content: '', toolsRemoved: [{ name: 'bash' }] },
      { role: 'assistant', content: [], usage: { input: 0, output: 0 } },
    ], 'deepseek', 'deepseek-v4-pro');
    expect(snap.usedTokens).toBe(105);
    expect(snap.contextWindow).toBe(1_000_000);
    expect(labels(snap as ContextSnapshot, 'system')).toEqual(['preamble']);
    expect(category(snap as ContextSnapshot, 'memory')?.items[0]).toMatchObject({ label: '/repo/AGENTS.md', content: 'rules here', path: '/repo/AGENTS.md' });
    expect(labels(snap as ContextSnapshot, 'tools')).toEqual(['read']);
    expect(labels(snap as ContextSnapshot, 'skills')).toEqual(['skills']);
    expect(labels(snap as ContextSnapshot, 'tool_io')).toEqual(['→ bash', '← bash']);
    expect(labels(snap as ContextSnapshot, 'reasoning')).toEqual(['thinking']);
  });
});

describe('grok context', () => {
  it('reads native history, tools and counters, carving memory files out of harness messages', async () => {
    const cwd = '/repo';
    const { grokNativeSessionPath } = await import('../../effect/grokNativeSessionLive');
    const dir = grokNativeSessionPath(cwd, 'g1');
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, 'chat_history.jsonl'), jsonl([
      { type: 'system', content: 'You are Grok' },
      { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS\n</user_info>\nMEMORY BODY' }] },
      { type: 'user', content: [{ type: 'text', text: '<system-reminder>skills</system-reminder>' }], synthetic_reason: 'system_reminder' },
      { type: 'user', content: [{ type: 'text', text: '<user_query>do it</user_query>' }] },
      { type: 'assistant', content: 'ok', tool_calls: [{ id: 'c1', name: 'read_file', arguments: '{"f":1}' }] },
      { type: 'tool_result', tool_call_id: 'c1', content: 'data' },
      { type: 'reasoning', summary: [], encrypted_content: 'x' },
    ]));
    await writeFile(join(dir, 'tool_definitions.json'), JSON.stringify([{ type: 'function', function: { name: 'read_file' } }]));
    await writeFile(join(dir, 'prompt_context.json'), JSON.stringify({ agents_md_files: [{ file_path: '/home/AGENTS.md', content: 'MEMORY BODY' }] }));
    await writeFile(join(dir, 'signals.json'), JSON.stringify({ contextTokensUsed: 500, contextWindowTokens: 256000, primaryModelId: 'grok-4.7' }));
    const snap = await Effect.runPromise(grok.buildGrokContext(cwd, 'g1'));
    expect(snap).toMatchObject({ engine: 'grok', model: 'grok-4.7', usedTokens: 500, contextWindow: 256000 });
    expect(category(snap, 'memory')?.items[0]).toMatchObject({ label: '/home/AGENTS.md', content: 'MEMORY BODY' });
    expect(category(snap, 'environment')?.items[0].content).toContain('[→ /home/AGENTS.md]');
    expect(labels(snap, 'instructions')).toEqual(['system reminder']);
    expect(labels(snap, 'tools')).toEqual(['read_file']);
    expect(labels(snap, 'tool_io')).toEqual(['→ read_file', '← read_file']);
    expect(snap.notes).toContain('reasoning_encrypted');
  });
});

describe('grok independent turns', () => {
  const cwd = '/repo-independent';
  const chat = [
    { type: 'system', content: 'You are Grok' },
    { type: 'user', content: [{ type: 'text', text: '<user_info>\nOS\n</user_info>' }] },
    { type: 'user', prompt_index: 0, content: [{ type: 'text', text: 'normal turn' }] },
    { type: 'assistant', content: 'normal answer' },
    { type: 'user', prompt_index: 1, content: [{ type: 'text', text: 'independent turn' }] },
    { type: 'assistant', content: 'independent answer' },
  ];
  const setup = async (id: string, files: Record<string, string>) => {
    const { grokNativeSessionPath } = await import('../../effect/grokNativeSessionLive');
    const dir = grokNativeSessionPath(cwd, id);
    await mkdir(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) await writeFile(join(dir, name), text);
    return dir;
  };
  const messages = (snap: ContextSnapshot) => category(snap, 'messages')?.items.map((i) => i.content);

  it('shows only the preamble and the merged independent turn, with that turn\'s usage', async () => {
    await setup('i1', {
      'chat_history.jsonl': jsonl(chat),
      'signals.json': JSON.stringify({ contextTokensUsed: 9999, contextWindowTokens: 256000 }),
      'cockpit-independent-context.json': JSON.stringify({ start: 4, length: 6, signals: { contextTokensUsed: 120, contextWindowTokens: 256000 } }),
    });
    const snap = await Effect.runPromise(grok.buildGrokContext(cwd, 'i1'));
    expect(messages(snap)).toEqual(['independent turn', 'independent answer']);
    expect(labels(snap, 'system')).toEqual(['system prompt']);
    expect(labels(snap, 'environment')).toEqual(['user_info']);
    expect(snap.usedTokens).toBe(120);
  });

  it('takes the request size from Cockpit\'s transcript, not Grok\'s signals counter', async () => {
    await setup('i4', {
      'chat_history.jsonl': jsonl(chat.slice(0, 4)),
      'signals.json': JSON.stringify({ contextTokensUsed: 1419, contextWindowTokens: 256000, primaryModelId: 'grok-old' }),
    });
    const { grokSessionPath } = await import('../../effect/grokSessionLive');
    const display = grokSessionPath(cwd, 'i4');
    await mkdir(join(display, '..'), { recursive: true });
    await writeFile(display, jsonl([
      { type: 'assistant', timestamp: 'T1', message: { role: 'assistant', model: 'grok-new', usage: { input_tokens: 19691, cache_read_input_tokens: 2176, output_tokens: 41 } } },
      { type: 'user', message: { role: 'user', content: 'tool output mentioning "usage"' } },
    ]));
    const snap = await Effect.runPromise(grok.buildGrokContext(cwd, 'i4'));
    expect(snap).toMatchObject({ usedTokens: 21908, model: 'grok-new', contextWindow: 256000, capturedAt: 'T1' });
  });

  it('falls back to the whole history once a later turn changed its length', async () => {
    await setup('i2', {
      'chat_history.jsonl': jsonl([...chat, { type: 'user', prompt_index: 2, content: [{ type: 'text', text: 'later normal turn' }] }]),
      'signals.json': JSON.stringify({ contextTokensUsed: 9999 }),
      'cockpit-independent-context.json': JSON.stringify({ start: 4, length: 6, signals: { contextTokensUsed: 120 } }),
    });
    const snap = await Effect.runPromise(grok.buildGrokContext(cwd, 'i2'));
    expect(messages(snap)).toEqual(['normal turn', 'normal answer', 'independent turn', 'independent answer', 'later normal turn']);
    expect(snap.usedTokens).toBe(9999);
  });

  it('reads the temporary branch while an independent turn is running', async () => {
    await setup('branch1', {
      'chat_history.jsonl': jsonl([chat[0], chat[1], { type: 'user', prompt_index: 0, content: [{ type: 'text', text: 'in flight' }] }]),
      'signals.json': JSON.stringify({ contextTokensUsed: 77 }),
    });
    await setup('i3', {
      'chat_history.jsonl': jsonl(chat),
      'signals.json': JSON.stringify({ contextTokensUsed: 9999 }),
      'cockpit-independent.json': JSON.stringify({ sessionId: 'branch1', offset: 2, preambleCount: 2 }),
    });
    const snap = await Effect.runPromise(grok.buildGrokContext(cwd, 'i3'));
    expect(messages(snap)).toEqual(['in flight']);
    expect(snap.usedTokens).toBe(77);
  });
});

describe('claude context', () => {
  const cwd = '/repo';
  const line = (r: Record<string, unknown>) => ({ isSidechain: false, timestamp: '2026-11-10T00:00:00Z', ...r });

  it('follows the active chain from the last compact boundary and falls back to estimates without a snapshot', async () => {
    const path = join(root, 'claude.jsonl');
    await writeFile(path, jsonl([
      line({ type: 'user', uuid: 'old', parentUuid: null, message: { role: 'user', content: 'before compaction' } }),
      line({ type: 'system', subtype: 'compact_boundary', uuid: 'b', parentUuid: null }),
      line({ type: 'user', uuid: 's', parentUuid: 'b', isCompactSummary: true, message: { role: 'user', content: 'SUMMARY' } }),
      line({ type: 'user', uuid: 'u1', parentUuid: 's', message: { role: 'user', content: 'question' } }),
      line({ type: 'assistant', uuid: 'abandoned', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'text', text: 'rewound reply' }] } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', model: 'claude-x', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'ls' } }],
        usage: { input_tokens: 5, cache_read_input_tokens: 100, cache_creation_input_tokens: 10, output_tokens: 3 } } }),
      line({ type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: 'files' }] } }),
      line({ type: 'user', uuid: 'side', parentUuid: 'r1', isSidechain: true, message: { role: 'user', content: 'subagent' } }),
    ]));
    const snap = await Effect.runPromise(claude.buildClaudeContext(cwd, 'c1', path));
    expect(snap).toMatchObject({ engine: 'claude', model: 'claude-x', usedTokens: 118, contextWindow: null });
    expect(category(snap, 'summary')?.items.map((i) => i.content)).toEqual(['SUMMARY']);
    expect(category(snap, 'messages')?.items.map((i) => i.content)).toEqual(['question']);
    expect(labels(snap, 'tool_io')).toEqual(['→ Bash', '← Bash']);
    expect(snap.notes).toEqual(expect.arrayContaining(['no_snapshot_yet', 'system_prompt_hidden', 'after_compaction']));
  });

  it('uses the captured CLI breakdown (exact total, estimated split) and reads memory files from disk', async () => {
    const path = join(root, 'claude2.jsonl');
    await writeFile(path, jsonl([
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }),
      line({ type: 'assistant', uuid: 'a1', parentUuid: 'u1', message: { role: 'assistant', content: [{ type: 'tool_use', id: 't', name: 'Read', input: {} }] } }),
      line({ type: 'user', uuid: 'r1', parentUuid: 'a1', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't', content: 'x' }] } }),
    ]));
    const memory = join(root, 'CLAUDE.md');
    await writeFile(memory, '# rules');
    await Effect.runPromise(store.saveClaudeContextUsage(cwd, 'c2', {
      categories: [
        { id: 'system_prompt', name: 'System prompt', tokens: 3000, color: '', kind: 'used' },
        { id: 'memory_files', name: 'Memory files', tokens: 40, color: '', kind: 'used' },
        { id: 'mcp_tools_deferred', name: 'MCP tools (deferred)', tokens: 999, color: '', kind: 'deferred', isDeferred: true },
        { id: 'messages', name: 'Messages', tokens: 500, color: '', kind: 'used' },
        { id: 'free_space', name: 'Free space', tokens: 90000, color: '', kind: 'free' },
      ],
      totalTokens: 3540, maxTokens: 200000, rawMaxTokens: 200000, percentage: 2, gridRows: [], model: 'claude-y',
      memoryFiles: [{ path: memory, type: 'Project', tokens: 40 }], mcpTools: [], agents: [],
      systemPromptSections: [{ name: 'Core', tokens: 3000 }],
      isAutoCompactEnabled: true,
      messageBreakdown: { toolCallTokens: 100, toolResultTokens: 50, attachmentTokens: 0, assistantMessageTokens: 0, userMessageTokens: 0, redirectedContextTokens: 0, unattributedTokens: 0, toolCallsByType: [] },
    } as unknown as Parameters<typeof store.saveClaudeContextUsage>[2]));
    const snap = await Effect.runPromise(claude.buildClaudeContext(cwd, 'c2', path));
    expect(snap).toMatchObject({ model: 'claude-y', usedTokens: 3540, contextWindow: 200000 });
    expect(snap.categories.map((c) => [c.id, c.tokens, c.exact])).toEqual([
      ['system', 3000, false], ['memory', 40, false], ['messages', 350, false], ['tool_io', 150, false],
    ]);
    expect(category(snap, 'system')?.items[0]).toMatchObject({ label: 'Core', tokens: 3000, exact: false });
    expect(category(snap, 'memory')?.items[0]).toMatchObject({ content: '# rules', path: memory, tokens: 40 });
    expect(snap.notes).toContain('snapshot_from_last_turn');
  });

  it('does not present the CLI request journal as the system prompt', async () => {
    const path = join(root, 'claude-journal.jsonl');
    await writeFile(path, jsonl([
      line({ type: 'user', uuid: 'u1', parentUuid: null, message: { role: 'user', content: 'hi' } }),
      { type: 'api-request-blob', hash: 'h1', message: { role: 'system', content: [{ type: 'text', text: '# Environment update\n - cwd' }] } },
      { type: 'api-request', id: 'r1', tail: ['h1'] },
    ]));
    const snap = await Effect.runPromise(claude.buildClaudeContext(cwd, 'journal', path));
    expect(category(snap, 'system')).toBeUndefined();
    expect(snap.notes).toContain('system_prompt_hidden');
  });

  it('rejects session ids that could escape the store directory', () => {
    expect(store.claudeContextUsagePath(cwd, '../evil')).toBeNull();
  });
});

describe('claude context snapshot retention', () => {
  const old = new Date(Date.now() - 2 * 3600 * 1000);
  const setup = async () => {
    const base = await mkdtemp(join(root, 'retention-'));
    const projects = join(base, 'cockpit-projects');
    const claudeProjects = join(base, 'claude-projects');
    const snapDir = join(projects, '-repo', 'context-usage');
    await mkdir(snapDir, { recursive: true });
    await mkdir(join(claudeProjects, '-repo', 'stashed'), { recursive: true });
    const snap = async (name: string, aged = true) => {
      const path = join(snapDir, name);
      await writeFile(path, '{}');
      if (aged) await utimes(path, old, old);
    };
    await snap('orphan.json');
    await snap('alive.json');
    await writeFile(join(claudeProjects, '-repo', 'alive.jsonl'), '');
    await snap('stashed.json');
    await writeFile(join(claudeProjects, '-repo', 'stashed', 'nohistory-backup.jsonl'), '');
    await snap('fresh.json', false);
    await snap('alive.json.123.tmp');
    return { projects, claudeProjects, snapDir };
  };

  it('removes snapshots whose transcript is gone, keeping live, stashed and recent ones', async () => {
    const { projects, claudeProjects, snapDir } = await setup();
    const removed = await Effect.runPromise(store.cleanupOrphanedContextUsage(projects, claudeProjects, 3600 * 1000));
    expect(removed).toBe(2);
    expect((await readdir(snapDir)).sort()).toEqual(['alive.json', 'fresh.json', 'stashed.json']);
  });

  it('is a no-op when the projects directory does not exist', async () => {
    expect(await Effect.runPromise(store.cleanupOrphanedContextUsage(join(root, 'missing'), join(root, 'missing2'), 0))).toBe(0);
  });

  it('drops one session\'s snapshot on demand', async () => {
    await Effect.runPromise(store.saveClaudeContextUsage('/repo-drop', 'gone', { categories: [] } as unknown as Parameters<typeof store.saveClaudeContextUsage>[2]));
    expect(await Effect.runPromise(store.readClaudeContextUsage('/repo-drop', 'gone'))).not.toBeNull();
    await Effect.runPromise(store.removeClaudeContextUsage('/repo-drop', 'gone'));
    expect(await Effect.runPromise(store.readClaudeContextUsage('/repo-drop', 'gone'))).toBeNull();
  });
});
