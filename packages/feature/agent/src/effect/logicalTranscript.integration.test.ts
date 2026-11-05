import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Effect } from 'effect';

const hooks = vi.hoisted(() => ({
  beforeStat: undefined as ((path: string) => void) | undefined,
  fault: undefined as ((op: string, path: string) => void) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const actual = await original<typeof import('node:fs/promises')>();
  return { ...actual, stat: (...args: unknown[]) => {
    hooks.beforeStat?.(String(args[0]));
    hooks.fault?.('stat', String(args[0]));
    return Reflect.apply(actual.stat, actual, args);
  }, readdir: (...args: unknown[]) => {
    hooks.fault?.('readdir', String(args[0]));
    return Reflect.apply(actual.readdir, actual, args);
  }, readFile: (...args: unknown[]) => {
    hooks.fault?.('readFile', String(args[0]));
    return Reflect.apply(actual.readFile, actual, args);
  }, open: (...args: unknown[]) => {
    hooks.fault?.('open', String(args[0]));
    return Reflect.apply(actual.open, actual, args);
  } };
});

const root = mkdtempSync(join(tmpdir(), 'cockpit-logical-flow-'));
process.env.HOME = join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
process.env.COCKPIT_HOME = join(root, 'cockpit');
const cwd = join(root, 'project');
let paths: typeof import('@cockpit/shared-utils');
let detail: typeof import('../server/api/session-by-path');
let titles: typeof import('../server/api/session-title');
let users: typeof import('../server/api/session/userMessages');
let projects: typeof import('../server/api/sessions/project-encoded');
let projectRegistry: typeof import('../server/api/sessions/projects');
let recent: typeof import('../server/state/globalState');
let hub: typeof import('../server/sessionRunHub');
let claude: typeof import('../server/engines/shared/noHistoryTranscript');
let codex: typeof import('../server/engines/shared/noHistoryRollout');
let searchLive: typeof import('./sessionSearchLive');
let services: typeof import('@cockpit/effect-services');

beforeAll(async () => {
  mkdirSync(cwd, { recursive: true });
  paths = await import('@cockpit/shared-utils');
  detail = await import('../server/api/session-by-path');
  titles = await import('../server/api/session-title');
  users = await import('../server/api/session/userMessages');
  projects = await import('../server/api/sessions/project-encoded');
  projectRegistry = await import('../server/api/sessions/projects');
  recent = await import('../server/state/globalState');
  hub = await import('../server/sessionRunHub');
  claude = await import('../server/engines/shared/noHistoryTranscript');
  codex = await import('../server/engines/shared/noHistoryRollout');
  searchLive = await import('./sessionSearchLive');
  services = await import('@cockpit/effect-services');
}, 30_000);
afterAll(() => rmSync(root, { recursive: true, force: true }));
const request = (body: unknown) => new Request('http://localhost/api/session', { method: 'POST', body: JSON.stringify(body) });
const line = (value: unknown) => JSON.stringify(value) + '\n';
const searchRun = <A, E>(f: (s: import('@cockpit/effect-services').SessionSearchService) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(services.SessionSearchService, f).pipe(Effect.provide(searchLive.SessionSearchServiceLive)));

describe('logical session end-to-end', () => {
  it('reads registered Codex sessions from project state even when the native cwd differs', async () => {
    const sessionId = '12345678-1111-4111-8111-111111111111';
    const alias = join(root, 'registered-project');
    const native = join(root, 'native-project');
    mkdirSync(alias, { recursive: true });
    const file = join(paths.CODEX_SESSIONS_DIR, '2026', '12', '02', `rollout-${sessionId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'session_meta', payload: { id: sessionId, cwd: native } }) + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: 'Registered project subject' }] } }));
    await recent.updateGlobalState(alias, sessionId, 'normal', undefined, undefined, 'codex');
    const state = paths.getSessionFilePath(alias);
    mkdirSync(dirname(state), { recursive: true });
    writeFileSync(state, JSON.stringify({ sessions: [sessionId], engines: { [sessionId]: 'codex' } }));
    const response = await projects.GET(new Request('http://localhost/api/sessions/project'), { params: Promise.resolve({ encodedPath: paths.encodePath(alias) }) });
    expect(response.status).toBe(200);
    expect((await response.json()).some((session: { sessionId: string }) => session.sessionId === sessionId)).toBe(true);
    const registry = await projectRegistry.GET(new Request('http://localhost/api/sessions/projects'));
    expect(registry.status).toBe(200);
    expect((await registry.json()).find((project: { fullPath: string }) => project.fullPath === alias)).toMatchObject({ sessionCount: 1 });
  });

  it('discovers a cold Codex session when only the history backup exists', async () => {
    const sessionId = '12345678-2222-4222-8222-222222222222';
    const file = join(paths.CODEX_SESSIONS_DIR, '2026', '12', '03', `rollout-${sessionId}.jsonl`);
    const keyword = 'BackupOnlyCodexNeedle';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'session_meta', payload: { id: sessionId, cwd } }) + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: keyword }] } }));
    renameSync(file, codex.codexNoHistoryStashPath(file));
    const identity = { cwd, sessionId };
    try {
      const title = await titles.POST(request(identity));
      expect(title.status).toBe(200);
      expect((await title.json()).title).toBe(keyword);
      const content = await detail.POST(request(identity));
      expect(content.status).toBe(200);
      expect((await content.json()).messages.some((message: { content: string }) => message.content === keyword)).toBe(true);
      expect((await (await users.POST(request(identity))).json()).messages).toHaveLength(1);
      const sessions = await (await projects.GET(new Request('http://localhost/api/sessions/project'), { params: Promise.resolve({ encodedPath: paths.encodePath(cwd) }) })).json();
      expect(sessions.find((session: { sessionId: string }) => session.sessionId === sessionId)).toMatchObject({ path: file, title: keyword });
      await searchRun((service) => service.sync);
      expect((await searchRun((service) => service.search({ terms: [keyword], limit: 10 }))).some((hit) => hit.sessionId === sessionId)).toBe(true);
      expect(JSON.parse(readFileSync(join(process.env.COCKPIT_HOME!, 'search-corpus', 'manifest.v2.json'), 'utf8'))[file]).toBeDefined();
    } finally { codex.mergeStashedCodexRollout(file); }
  });

  it('keeps Codex search data when the current rollout moves during discovery', async () => {
    const sessionId = '12345678-4444-4444-8444-444444444444';
    const file = join(paths.CODEX_SESSIONS_DIR, '2026', '12', '04', `rollout-${sessionId}.jsonl`);
    const keyword = 'MovingCodexDiscoveryNeedle';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'session_meta', payload: { id: sessionId, cwd } }) + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: keyword }] } }));
    await searchRun((service) => service.sync);
    let moved = false;
    hooks.beforeStat = (path) => {
      if (path === file && !moved) { moved = true; renameSync(file, codex.codexNoHistoryStashPath(file)); }
    };
    try {
      await searchRun((service) => service.sync);
      expect(moved).toBe(true);
      expect((await searchRun((service) => service.search({ terms: [keyword], limit: 10 }))).some((hit) => hit.sessionId === sessionId)).toBe(true);
      expect((await (await titles.POST(request({ cwd, sessionId }))).json()).title).toBe(keyword);
    } finally { hooks.beforeStat = undefined; codex.mergeStashedCodexRollout(file); }
  });

  it.each(['title', 'detail', 'users'] as const)('retries a Claude restore during the %s API storage lookup', async (api) => {
    const sessionId = `resolver-restore-${api}`;
    const file = paths.getClaudeSessionPath(cwd, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'Resolver restore subject' } }));
    claude.stashTranscript(file);
    let restored = false;
    hooks.beforeStat = (path) => {
      if (path === claude.noHistoryStashPath(file) && !restored) {
        restored = true;
        renameSync(path, file);
      }
    };
    try {
      const response = await ({ title: titles, detail, users }[api]).POST(request({ cwd, sessionId }));
      expect(restored).toBe(true);
      expect(response.status).toBe(200);
      const body = await response.json();
      if (api === 'users') expect(body.messages[0].content).toBe('Resolver restore subject');
      else expect(body.defaultTitle).toBe('Resolver restore subject');
    } finally { hooks.beforeStat = undefined; claude.mergeStashedTranscript(file); }
  });

  it('propagates Pi file discovery failures through APIs instead of reporting a missing session', async () => {
    const pi = await import('./piSessionLive');
    const project = join(root, 'pi-strict-project');
    const sessionId = '12345678-3333-4333-8333-333333333333';
    const dir = paths.getPiSessionsDir(project);
    const file = join(dir, `2026-01-01_${sessionId}.jsonl`);
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, [
      { type: 'session', version: 3, id: sessionId, cwd: project, timestamp: '2026-01-01T00:00:00.000Z' },
      { type: 'message', id: 'u', parentId: null, message: { role: 'user', content: 'Pi strict subject', timestamp: 1 }, timestamp: '2026-01-01T00:00:01.000Z' },
    ].map(line).join(''));
    expect((await Effect.runPromise(pi.findPiSession(project, sessionId)))?.id).toBe(sessionId);
    try {
      for (const [op, target] of [['readdir', dir], ['readFile', file], ['stat', file], ['open', file]]) for (const code of ['EACCES', 'EIO']) {
        let injected = false;
        hooks.fault = (actualOp, path) => {
          if (actualOp === op && path === target) { injected = true; throw Object.assign(new Error(`Injected ${code}`), { code }); }
        };
        try {
          expect((await Effect.runPromise(Effect.either(pi.findPiSession(project, sessionId))))._tag, `${op} ${code}`).toBe('Left');
          if (op !== 'open') expect((await Effect.runPromise(Effect.either(pi.listPiSessions(project))))._tag).toBe('Left');
          for (const api of [titles, detail, users]) {
            const response = await api.POST(request({ cwd: project, sessionId }));
            expect(response.status).toBeGreaterThanOrEqual(400);
            expect(response.status).not.toBe(404);
          }
          expect(injected).toBe(true);
        } finally { hooks.fault = undefined; }
      }
      rmSync(file);
      expect(await Effect.runPromise(pi.findPiSession(project, sessionId))).toBeUndefined();
      expect(await Effect.runPromise(pi.listPiSessions(project))).toEqual([]);
    } finally { hooks.fault = undefined; rmSync(file, { force: true }); }
  });

  it.each(['local', 'other-process'] as const)('retries a %s no-output restore between the two layout probes', async (actor) => {
    const sessionId = `restore-between-probes-${actor}`;
    const file = paths.getClaudeSessionPath(cwd, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'user', cwd, sessionId, message: { role: 'user', content: 'Original restored subject' } }));
    const { readLogicalTranscript } = await import('./logicalTranscript');
    const { defaultSessionTitle } = await import('../server/transcriptViews');
    const { transcriptGeneration } = await import('./transcriptIndexLive');
    claude.stashTranscript(file);
    const generation = transcriptGeneration(file);
    let restored = false;
    hooks.beforeStat = (path) => {
      if (path !== claude.noHistoryStashPath(file) || restored) return;
      restored = true;
      if (actor === 'local') claude.mergeStashedTranscript(file);
      else {
        const child = spawnSync(process.execPath, ['-e', 'require("node:fs").renameSync(process.argv[1], process.argv[2]);', claude.noHistoryStashPath(file), file]);
        expect(child.status).toBe(0);
      }
    };
    try {
      const title = await Effect.runPromise(readLogicalTranscript(file, 'claude', (view) => view.projection.pipe(Effect.map(defaultSessionTitle))));
      expect(restored).toBe(true);
      expect(title).toBe('Original restored subject');
      expect(transcriptGeneration(file)).toBe(actor === 'local' ? generation + 1 : generation);
    } finally { hooks.beforeStat = undefined; claude.mergeStashedTranscript(file); }
  });

  it('keeps the manifest and corpus when any discovery layer fails, but cleans up real deletions', async () => {
    const id = 'eeeeeeee-5555-4555-8555-555555555555';
    const dir = join(paths.CODEX_SESSIONS_DIR, '2026', '12', '01');
    const file = join(dir, `rollout-${id}.jsonl`);
    const keyword = 'StrictInventoryNeedle';
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, line({ type: 'session_meta', payload: { id, cwd } }) + line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text: keyword }] } }));
    await searchRun((service) => service.sync);
    const manifest = join(process.env.COCKPIT_HOME!, 'search-corpus', 'manifest.v2.json');
    const before = readFileSync(manifest);
    const { invalidateTranscript } = await import('./transcriptIndexLive');
    const probes = [
      ['readdir', paths.CLAUDE_PROJECTS_DIR], ['readdir', paths.GROK_SESSIONS_DIR], ['readdir', paths.PI_SESSIONS_DIR],
      ['stat', paths.CODEX_SESSIONS_DIR], ['readdir', paths.CODEX_SESSIONS_DIR],
      ['stat', dir], ['readdir', dir], ['stat', file], ['open', file],
    ];
    let time = Date.now();
    for (const [op, target] of probes) for (const code of ['EACCES', 'EIO']) {
      invalidateTranscript(file);
      if (op === 'readdir' && target.startsWith(paths.CODEX_SESSIONS_DIR)) utimesSync(target, new Date(++time), new Date(time));
      let injected = false;
      hooks.fault = (actualOp, path) => {
        if (actualOp === op && path === target) {
          injected = true;
          throw Object.assign(new Error(`Injected ${code}`), { code });
        }
      };
      try {
        expect((await searchRun((service) => Effect.either(service.sync)))._tag, `${op} ${target} ${code}`).toBe('Left');
        expect(injected).toBe(true);
        expect(readFileSync(manifest)).toEqual(before);
        expect((await searchRun((service) => service.search({ terms: [keyword], limit: 10 }))).some((hit) => hit.sessionId === id)).toBe(true);
        expect((await projectRegistry.GET(new Request('http://localhost/api/sessions/projects'))).status).toBeGreaterThanOrEqual(400);
      } finally { hooks.fault = undefined; }
    }
    rmSync(file);
    await searchRun((service) => service.sync);
    expect((await searchRun((service) => service.search({ terms: [keyword], limit: 10 }))).some((hit) => hit.sessionId === id)).toBe(false);
    expect(JSON.parse(readFileSync(manifest, 'utf8'))[file]).toBeUndefined();
  });
  it('keeps a restoring session discoverable and retains search data on discovery failure', async () => {
    const sessionId = 'dddddddd-4444-4444-8444-444444444444';
    const file = paths.getClaudeSessionPath(cwd, sessionId);
    const keyword = 'RestoreDiscoveryNeedle';
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'user', cwd, sessionId, message: { role: 'user', content: keyword } }));
    const { listLogicalTranscriptFiles } = await import('./logicalTranscript');
    const { invalidateTranscript } = await import('./transcriptIndexLive');
    const stash = claude.noHistoryStashPath(file);
    await searchRun((service) => service.sync);
    claude.stashTranscript(file);
    let restored = false;
    hooks.beforeStat = (path) => {
      if (path === stash && !restored) { restored = true; claude.mergeStashedTranscript(file); }
    };
    try {
      expect(await Effect.runPromise(listLogicalTranscriptFiles(dirname(file), 'claude'))).toContain(`${sessionId}.jsonl`);
      expect(restored).toBe(true);
      await searchRun((service) => service.sync);
      expect((await searchRun((service) => service.search({ terms: [keyword], limit: 10 }))).some((hit) => hit.sessionId === sessionId)).toBe(true);
      // A source inventory that never stabilizes must fail the sync without
      // publishing an empty inventory or deleting the previously indexed corpus.
      hooks.beforeStat = (path) => { if (path === stash) invalidateTranscript(file); };
      const result = await searchRun((service) => Effect.either(service.sync));
      expect(result._tag).toBe('Left');
      expect((await searchRun((service) => service.search({ terms: [keyword], limit: 10 }))).some((hit) => hit.sessionId === sessionId)).toBe(true);
      expect((await projects.GET(new Request('http://localhost/api/sessions/project'), { params: Promise.resolve({ encodedPath: paths.encodePath(cwd) }) })).status).toBeGreaterThanOrEqual(400);
      expect((await projectRegistry.GET(new Request('http://localhost/api/sessions/projects'))).status).toBeGreaterThanOrEqual(400);
    } finally {
      hooks.beforeStat = undefined;
      claude.mergeStashedTranscript(file);
    }
  });
  it.each(['EACCES', 'EIO'])('fails project lists on an unreadable Claude file (%s)', async (code) => {
    const project = join(root, `unreadable-project-${code}`);
    const sessionId = `unreadable-${code}`;
    const file = paths.getClaudeSessionPath(project, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'user', cwd: project, sessionId, message: { role: 'user', content: 'Unreadable subject' } }));
    let injected = false;
    hooks.fault = (op, path) => {
      if (op === 'open' && path === file) { injected = true; throw Object.assign(new Error(`Injected ${code}`), { code }); }
    };
    try {
      const list = await projects.GET(new Request('http://localhost/api/sessions/project'), { params: Promise.resolve({ encodedPath: paths.encodePath(project) }) });
      expect(list.status).toBeGreaterThanOrEqual(400);
      const registry = await projectRegistry.GET(new Request('http://localhost/api/sessions/projects'));
      expect(registry.status).toBeGreaterThanOrEqual(400);
      expect(injected).toBe(true);
    } finally { hooks.fault = undefined; rmSync(file, { force: true }); }
  });

  it.each(['list', 'registry'] as const)('omits a Claude file genuinely deleted during the %s read', async (api) => {
    const project = join(root, `deleted-project-${api}`);
    const sessionId = `deleted-${api}`;
    const file = paths.getClaudeSessionPath(project, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, line({ type: 'user', cwd: project, sessionId, message: { role: 'user', content: 'Deleted subject' } }));
    let deleted = false;
    hooks.fault = (op, path) => {
      if (op === 'open' && path === file && !deleted) { deleted = true; rmSync(file); }
    };
    try {
      const response = api === 'list'
        ? await projects.GET(new Request('http://localhost/api/sessions/project'), { params: Promise.resolve({ encodedPath: paths.encodePath(project) }) })
        : await projectRegistry.GET(new Request('http://localhost/api/sessions/projects'));
      expect(deleted).toBe(true);
      expect(response.status).toBe(200);
      const body = await response.json();
      if (api === 'list') expect(body).toEqual([]);
      else expect(body.some((entry: { fullPath: string }) => entry.fullPath === project)).toBe(false);
    } finally { hooks.fault = undefined; rmSync(file, { force: true }); }
  });

  it('excludes injected messages from preview head, tail, last message and search text', async () => {
    const sessionId = 'preview-meta-filter';
    const file = paths.getClaudeSessionPath(cwd, sessionId);
    const messages = [
      { text: 'InjectedPreviewNeedle head', isMeta: true },
      ...Array.from({ length: 11 }, (_, i) => ({ text: `Human message ${i}`, isMeta: false })),
      { text: 'InjectedPreviewNeedle tail', isMeta: true },
    ];
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, messages.map(({ text, isMeta }, i) => line({ type: 'user', uuid: `preview-${i}`, cwd, sessionId, isMeta, message: { role: 'user', content: text } })).join(''));
    const preview = await recent.getSessionPreview(cwd, sessionId, { includeSearchText: true });
    expect(preview.firstMessages).toEqual(Array.from({ length: 5 }, (_, i) => `Human message ${i}`));
    expect(preview.lastMessages).toEqual(Array.from({ length: 5 }, (_, i) => `Human message ${i + 6}`));
    expect(preview.lastUserMessage).toBe('Human message 10');
    expect(preview.searchText).not.toContain('injectedpreviewneedle');
  });

  it.each(['claude', 'codex'] as const)('reads %s status, history and fork from the logical source', async (engine) => {
    const sessionId = engine === 'claude' ? '12345678-5555-4555-8555-555555555555' : '12345678-6666-4666-8666-666666666666';
    const file = engine === 'claude' ? paths.getClaudeSessionPath(cwd, sessionId) : join(paths.CODEX_SESSIONS_DIR, '2026', '12', '05', `rollout-${sessionId}.jsonl`);
    const original = 'Logical status original';
    const say = (role: string, text: string) => engine === 'claude'
      ? { type: role, uuid: `${role}-${text}`, sessionId, cwd, message: { role, content: role === 'assistant' ? [{ type: 'text', text }] : text, stop_reason: role === 'assistant' ? 'end_turn' : undefined } }
      : { type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, (engine === 'codex' ? line({ type: 'session_meta', payload: { id: sessionId, cwd } }) : '') + line(say('user', original)) + line(say('assistant', 'Original reply')));
    const stash = engine === 'claude' ? claude.stashTranscript : codex.stashCodexRollout;
    const merge = engine === 'claude' ? claude.mergeStashedTranscript : codex.mergeStashedCodexRollout;
    stash(file);
    hub.startRun(sessionId, cwd, 'Independent prompt', sessionId, engine);
    const { DelegationServiceLive } = await import('./delegationLive');
    const readStatus = () => Effect.runPromise(Effect.flatMap(services.DelegationService, (service) => service.status(cwd, sessionId)).pipe(Effect.provide(DelegationServiceLive)));
    try {
      expect(await readStatus()).toMatchObject({ status: 'running', title: original, lastReply: 'Original reply' });
      const history = await import('../server/api/session/history');
      const response = await history.GET(new Request(`http://localhost/history?cwd=${encodeURIComponent(cwd)}`), { params: Promise.resolve({ sessionId }) });
      expect(response.status).toBe(200);
      expect((await response.json()).messages.map((message: { content: string }) => message.content)).toContain(original);
      const fork = await import('../server/api/session/fork');
      const copied = await fork.POST(request({ cwd, sessionId }), { params: Promise.resolve({ sessionId }) });
      expect(copied.status).toBe(200);
      const child = await copied.json();
      const childDetail = await detail.POST(request({ cwd, sessionId: child.newSessionId }));
      expect(childDetail.status).toBe(200);
      expect((await childDetail.json()).messages.some((message: { content: string }) => message.content === original)).toBe(true);
      appendFileSync(file, line(say('user', 'Independent prompt')));
      hub.markRunIdle(sessionId); hub.releaseRun(sessionId);
      expect((await readStatus()).status).toBe('incomplete');
      appendFileSync(file, line(say('assistant', 'New reply')) + (engine === 'codex' ? line({ type: 'event_msg', payload: { type: 'task_complete' } }) : ''));
      expect(await readStatus()).toMatchObject({ status: 'done', lastReply: 'New reply' });
    } finally { hub.markRunIdle(sessionId); hub.releaseRun(sessionId); merge(file); }
  });

  it.each(['# Please check login', '<config>debug</config>', '<command-name>my XML</command-name>', '<local-command-stdout>x</local-command-stdout>'])('retains ordinary Codex input %s across previews, detail and search', async (text) => {
    const sessionId = `12345678-8888-4888-8888-${['# Please check login', '<config>debug</config>', '<command-name>my XML</command-name>', '<local-command-stdout>x</local-command-stdout>'].indexOf(text).toString().padStart(12, '0')}`;
    const file = join(paths.CODEX_SESSIONS_DIR, '2026', '12', '06', `rollout-${sessionId}.jsonl`);
    mkdirSync(dirname(file), { recursive: true });
    const say = (text: string) => line({ type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } });
    writeFileSync(file, line({ type: 'session_meta', payload: { id: sessionId, cwd } }) + say('# AGENTS.md instructions for /example') + say('<environment_context>injected</environment_context>') + say(text));
    const preview = await recent.getSessionPreview(cwd, sessionId, { includeSearchText: true });
    expect(preview).toMatchObject({ firstMessages: [text], lastUserMessage: text, defaultTitle: text });
    expect(preview.searchText).toContain(text.toLowerCase());
    expect(preview.searchText).not.toContain('injected');
    const body = await (await detail.POST(request({ cwd, sessionId }))).json();
    expect(body.messages.filter((message: { role: string }) => message.role === 'user').map((message: { content: string }) => message.content)).toEqual([text]);
    await searchRun((service) => service.sync);
    expect((await searchRun((service) => service.search({ terms: [text], limit: 10 }))).some((hit) => hit.sessionId === sessionId)).toBe(true);
  });

  it('uses queued human input in titles, lists, previews, search and message indexes', async () => {
    const sessionId = 'cccccccc-3333-4333-8333-333333333333';
    const file = paths.getClaudeSessionPath(cwd, sessionId);
    mkdirSync(dirname(file), { recursive: true });
    const prompt = 'Check the payment flow';
    writeFileSync(file, [
      { type: 'user', uuid: 'command', cwd, sessionId, message: { role: 'user', content: '/qa' } },
      { type: 'attachment', uuid: 'queued', cwd, sessionId, attachment: { type: 'queued_command', commandMode: 'prompt', prompt } },
    ].map(line).join(''));
    const identity = { cwd, sessionId };
    const expected = `/qa ${prompt}`;
    expect((await (await titles.POST(request(identity))).json()).defaultTitle).toBe(expected);
    expect((await (await detail.POST(request(identity))).json()).defaultTitle).toBe(expected);
    expect((await recent.getSessionPreview(cwd, sessionId))).toMatchObject({ defaultTitle: expected, firstMessages: ['/qa', prompt] });
    const list = await (await projects.GET(new Request('http://localhost/api/sessions/project'), { params: Promise.resolve({ encodedPath: paths.encodePath(cwd) }) })).json();
    expect(list.find((session: { sessionId: string }) => session.sessionId === sessionId)).toMatchObject({ title: expected, firstMessages: ['/qa', prompt] });
    const messages = await (await users.POST(request(identity))).json();
    expect(messages.messages.map((message: { content: string }) => message.content)).toEqual(['/qa', prompt]);
    await searchRun((service) => service.sync);
    expect((await searchRun((service) => service.search({ terms: ['payment flow'], limit: 10 }))).find((hit) => hit.sessionId === sessionId)?.title).toBe(expected);
  });
  it.each(['claude', 'codex'] as const)('keeps every %s API consistent through an independent task', async (engine) => {
    const sid = engine === 'claude' ? 'aaaaaaaa-1111-4111-8111-111111111111' : 'bbbbbbbb-2222-4222-8222-222222222222';
    const file = engine === 'claude' ? paths.getClaudeSessionPath(cwd, sid)
      : join(paths.CODEX_SESSIONS_DIR, '2026', '11', '04', `rollout-${sid}.jsonl`);
    const original = `${engine} OriginalHistoryNeedle`;
    const current = `${engine} IndependentTurnNeedle`;
    const user = (text: string, uuid: string) => engine === 'codex'
      ? { type: 'response_item', payload: { type: 'message', role: 'user', content: [{ type: 'input_text', text }] } }
      : { type: 'user', uuid, parentUuid: null, sessionId: sid, cwd, message: { role: 'user', content: text } };
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, (engine === 'codex' ? line({ type: 'session_meta', payload: { id: sid, cwd } }) : '') + line(user(original, 'u1')));
    const identity = { cwd, sessionId: sid };
    const initial = await (await detail.POST(request(identity))).json();
    expect(initial.title).toBe(original);
    const stash = engine === 'claude' ? claude.stashTranscript : codex.stashCodexRollout;
    const merge = engine === 'claude' ? claude.mergeStashedTranscript : codex.mergeStashedCodexRollout;
    expect(stash(file)).toBe(true);
    expect(hub.startRun(sid, cwd, current, undefined, engine)).toBe(true);
    await recent.updateGlobalState(cwd, sid, 'loading', undefined, current, engine);
    const list = async () => (await projects.GET(new Request('http://localhost/api/sessions/project'), { params: Promise.resolve({ encodedPath: paths.encodePath(cwd) }) })).json();
    try {
      // The Claude current file is absent; the Codex current file is only a stub.
      expect((await (await titles.POST(request(identity))).json()).title).toBe(original);
      expect((await list()).find((s: { sessionId: string }) => s.sessionId === sid)?.title).toBe(original);
      const registry = await (await projectRegistry.GET(new Request('http://localhost/api/sessions/projects'))).json();
      expect(registry.some((project: { fullPath: string; sessionCount: number }) => project.fullPath === cwd && project.sessionCount > 0)).toBe(true);
      await searchRun((service) => service.sync);
      expect((await searchRun((service) => service.search({ terms: [engine, 'OriginalHistoryNeedle'], limit: 10 }))).some((hit) => hit.sessionId === sid)).toBe(true);

      appendFileSync(file, line(user(current, 'u2')));
      const running = await (await detail.POST(request({ ...identity, ifFingerprint: initial.fingerprint }))).json();
      expect(running.notModified).toBeUndefined();
      expect(running.title).toBe(original);
      expect(running.messages.filter((m: { role: string }) => m.role === 'user').map((m: { content: string }) => m.content)).toEqual([original, current]);
      const index = await (await users.POST(request(identity))).json();
      expect(index.messages.map((entry: { id: string }) => entry.id)).toEqual(running.messages.filter((m: { role: string }) => m.role === 'user').map((m: { id: string }) => m.id));
      expect((await recent.getSessionPreview(cwd, sid)).firstMessages).toEqual([original, current]);
      expect((await list()).find((s: { sessionId: string }) => s.sessionId === sid)?.firstMessages).toEqual([original, current]);
      expect((await recent.getGlobalSessionsSnapshot()).find((s) => s.sessionId === sid)?.title).toBe(original);
      await searchRun((service) => service.sync);
      for (const keyword of ['OriginalHistoryNeedle', 'IndependentTurnNeedle']) {
        expect((await searchRun((service) => service.search({ terms: [engine, keyword], limit: 10 }))).find((hit) => hit.sessionId === sid)?.title).toBe(original);
      }
      const unchanged = await (await detail.POST(request({ ...identity, ifFingerprint: running.fingerprint }))).json();
      expect(unchanged.notModified).toBe(true);

      const renamed = await (await titles.POST(request({ ...identity, customTitle: 'Unified custom subject' }))).json();
      expect(renamed.title).toBe('Unified custom subject');
      expect((await (await detail.POST(request({ ...identity, ifFingerprint: running.fingerprint }))).json()).title).toBe(renamed.title);
      expect((await list()).find((s: { sessionId: string }) => s.sessionId === sid)?.title).toBe(renamed.title);
      expect((await (await titles.POST(request({ ...identity, customTitle: null }))).json()).title).toBe(original);

      merge(file);
      hub.markRunIdle(sid);
      hub.releaseRun(sid);
      const completed = await (await detail.POST(request(identity))).json();
      expect(completed.title).toBe(original);
      expect(completed.messages.map((m: { id: string }) => m.id)).toEqual(running.messages.map((m: { id: string }) => m.id));
      await searchRun((service) => service.sync);
      expect((await searchRun((service) => service.search({ terms: [engine, 'OriginalHistoryNeedle'], limit: 10 }))).find((hit) => hit.sessionId === sid)?.title).toBe(original);
    } finally {
      merge(file);
      hub.markRunIdle(sid);
      hub.releaseRun(sid);
    }
  }, 20_000);
});
