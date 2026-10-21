// End-to-end over a throwaway HOME / COCKPIT_HOME: paths.ts reads both at module load,
// so the env is set before the modules are imported.
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { Effect } from 'effect';
import { writeAtomically } from '@cockpit/effect-runtime/server/fs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-ss-'));
const home = path.join(root, 'home');
const cockpitHome = path.join(root, 'cockpit');
process.env.HOME = home;
// os.homedir() reads USERPROFILE on Windows, not HOME.
process.env.USERPROFILE = home;
process.env.COCKPIT_HOME = cockpitHome;

type LiveMod = typeof import('./sessionSearchLive');
type Services = typeof import('@cockpit/effect-services');
type QueryMod = typeof import('../shared/sessionSearchQuery');
let live: LiveMod;
let services: Services;
let query: QueryMod;
let encodePath: (cwd: string) => string;

const CLAUDE_SID = '11111111-1111-4111-8111-111111111111';
const KIMI_SID = '22222222-2222-4222-8222-222222222222';
const GLM_SID = '44444444-4444-4444-8444-444444444444';
const projA = '/tmp/projA';
const projB = '/tmp/projB';
const projC = '/tmp/projC';
let claudeFile: string;
let kimiFile: string;

const line = (o: unknown) => JSON.stringify(o) + '\n';
const user = (text: string, extra: Record<string, unknown> = {}) =>
  line({ type: 'user', uuid: `u-${Math.random()}`, timestamp: '2026-09-01T00:00:00.000Z', message: { role: 'user', content: text }, ...extra });
const assistant = (text: string) =>
  line({ type: 'assistant', uuid: `a-${Math.random()}`, timestamp: '2026-09-01T00:00:05.000Z', message: { role: 'assistant', content: [{ type: 'text', text }] } });

const run = <A, E>(eff: (svc: import('@cockpit/effect-services').SessionSearchService) => Effect.Effect<A, E>) =>
  Effect.runPromise(
    Effect.flatMap(services.SessionSearchService, eff).pipe(Effect.provide(live.SessionSearchServiceLive)),
  );
const sync = () => run((s) => s.sync);
const search = (terms: string[], extra: { cwd?: string; since?: number } = {}) =>
  run((s) => s.search({ terms, limit: 10, ...extra }));

beforeAll(async () => {
  ({ encodePath } = await import('@cockpit/shared-utils/encodePath'));
  services = await import('@cockpit/effect-services');
  live = await import('./sessionSearchLive');
  query = await import('../shared/sessionSearchQuery');

  const claudeDir = path.join(home, '.claude', 'projects', encodePath(projA));
  fs.mkdirSync(claudeDir, { recursive: true });
  claudeFile = path.join(claudeDir, `${CLAUDE_SID}.jsonl`);
  fs.writeFileSync(
    claudeFile,
    user('我们讨论一下影子快照的白名单问题', { cwd: projA, sessionId: CLAUDE_SID }) +
      assistant('建议在 HTTP 中间件里做 CSRF 的 Origin 校验'),
  );
  fs.writeFileSync(path.join(claudeDir, 'agent-x.jsonl'), user('快照 sidechain noise', { cwd: projA }));

  const kimiDir = path.join(cockpitHome, 'kimi-sessions', encodePath(projB));
  fs.mkdirSync(kimiDir, { recursive: true });
  kimiFile = path.join(kimiDir, `${KIMI_SID}.jsonl`);
  fs.writeFileSync(kimiFile, user('小程序怎么部署到轻量服务器') + assistant('用 docker 启动即可'));

  // A built-in session whose project is not registered yet (cwd unresolvable at first).
  const glmDir = path.join(cockpitHome, 'glm-sessions', encodePath(projC));
  fs.mkdirSync(glmDir, { recursive: true });
  fs.writeFileSync(path.join(glmDir, `${GLM_SID}.jsonl`), user('迁移数据库的回滚方案') + assistant('先备份'));

  fs.writeFileSync(path.join(cockpitHome, 'projects.json'), JSON.stringify({ projects: [{ cwd: projB }] }));
});

afterAll(() => {
  fs.rmSync(root, { recursive: true, force: true });
});

describe('SessionSearchServiceLive', () => {
  it('indexes top-level sessions from claude and built-in stores, skipping sidechains', async () => {
    const stats = await sync();
    expect(stats.indexed).toBe(3);
    expect(stats.rebuilt).toBe(3);
  });

  it('matches a 2-character Chinese word and resolves the claude cwd', async () => {
    const hits = await search(['快照']);
    expect(hits).toHaveLength(1);
    expect(hits[0]).toMatchObject({ engine: 'claude', sessionId: CLAUDE_SID, cwd: projA });
    expect(hits[0].link).toContain(encodeURIComponent(CLAUDE_SID));
  });

  it('matches assistant replies, case-insensitively', async () => {
    expect((await search(['csrf'])).map((h) => h.sessionId)).toEqual([CLAUDE_SID]);
  });

  it('resolves a built-in engine session cwd via projects.json', async () => {
    expect((await search(['小程序']))[0]).toMatchObject({ engine: 'kimi', sessionId: KIMI_SID, cwd: projB });
  });

  it('ranks by distinct terms matched and filters by cwd', async () => {
    expect((await search(['docker', '白名单', '中间件']))[0].sessionId).toBe(CLAUDE_SID);
    expect((await search(['docker', '白名单'], { cwd: projB })).map((h) => h.sessionId)).toEqual([KIMI_SID]);
  });

  it('matches a keyword that only appears in a markdown heading inside a reply', async () => {
    fs.appendFileSync(kimiFile, user('给个结论') + assistant('结论如下：\n\n## 独特标题关键词\n具体说明'));
    await sync();
    expect((await search(['独特标题关键词'])).map((h) => h.sessionId)).toEqual([KIMI_SID]);
  });

  it('does not match header metadata other than the title', async () => {
    expect(await search(['projB'])).toHaveLength(0);
  });

  it('re-indexes a session once its previously unknown project becomes resolvable', async () => {
    const before = await search(['回滚方案']);
    expect(before[0]).toMatchObject({ sessionId: GLM_SID, cwd: null, link: null });
    expect(await search(['回滚方案'], { cwd: projC })).toHaveLength(0);

    fs.writeFileSync(path.join(cockpitHome, 'projects.json'), JSON.stringify({ projects: [{ cwd: projB }, { cwd: projC }] }));
    const stats = await sync();
    expect(stats.rebuilt).toBe(1);
    const after = await search(['回滚方案'], { cwd: projC });
    expect(after[0]).toMatchObject({ sessionId: GLM_SID, cwd: projC });
    expect(after[0].link).toContain(encodeURIComponent(GLM_SID));
  });

  it('recovers an unknown cwd from a claude transcript that appears later in the same encoded dir', async () => {
    const projD = '/tmp/projD';
    const sid = '77777777-7777-4777-8777-777777777777';
    const ollamaDir = path.join(cockpitHome, 'ollama-sessions', encodePath(projD));
    fs.mkdirSync(ollamaDir, { recursive: true });
    fs.writeFileSync(path.join(ollamaDir, `${sid}.jsonl`), user('灰度发布的开关设计') + assistant('用配置中心'));
    await sync();
    expect((await search(['灰度发布']))[0]).toMatchObject({ sessionId: sid, cwd: null });

    // Only evidence of the directory: a claude session created later for the same project.
    const claudeDir = path.join(home, '.claude', 'projects', encodePath(projD));
    fs.mkdirSync(claudeDir, { recursive: true });
    fs.writeFileSync(path.join(claudeDir, '88888888-8888-4888-8888-888888888888.jsonl'), user('hello', { cwd: projD }) + assistant('hi'));
    await sync();
    const hits = await search(['灰度发布'], { cwd: projD });
    expect(hits[0]).toMatchObject({ sessionId: sid, cwd: projD });
    expect(hits[0].link).toContain(encodeURIComponent(sid));
  });

  // chmod 0o000 cannot make a file unreadable as root, nor on Windows.
  it.skipIf(process.getuid?.() === 0 || process.platform === 'win32')('keeps the indexed copy on a read failure and retries once readable again', async () => {
    const sid = '99999999-9999-4999-8999-999999999999';
    const dsDir = path.join(cockpitHome, 'deepseek-sessions', encodePath(projB));
    fs.mkdirSync(dsDir, { recursive: true });
    const file = path.join(dsDir, `${sid}.jsonl`);
    fs.writeFileSync(file, user('熔断阈值怎么定') + assistant('按错误率'));
    await sync();
    expect((await search(['熔断阈值'])).map((h) => h.sessionId)).toContain(sid);

    fs.appendFileSync(file, user('再补充一个限流词'));
    fs.chmodSync(file, 0o000);
    try {
      await sync();
      // Old copy still searchable; the new content is not indexed yet.
      expect((await search(['熔断阈值'])).map((h) => h.sessionId)).toContain(sid);
      expect((await search(['限流词'])).map((h) => h.sessionId)).not.toContain(sid);
    } finally {
      fs.chmodSync(file, 0o644);
    }
    // Readable again, same fingerprint as the failed attempt: it must still be retried.
    await sync();
    expect((await search(['限流词'])).map((h) => h.sessionId)).toContain(sid);
  });

  it('publishes corpus files atomically (no temp files left behind)', async () => {
    await sync();
    const leftovers: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const p = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(p);
        else if (entry.name.endsWith('.tmp')) leftovers.push(p);
      }
    };
    walk(path.join(cockpitHome, 'search-corpus'));
    expect(leftovers).toEqual([]);
  });

  it('is incremental: unchanged sources are not rebuilt, changed ones are', async () => {
    expect((await sync()).rebuilt).toBe(0);
    fs.appendFileSync(kimiFile, user('再加一个关键字 websocket'));
    expect((await sync()).rebuilt).toBe(1);
    expect((await search(['websocket']))[0]?.sessionId).toBe(KIMI_SID);
  });

  it('drops the corpus file when the source session is deleted', async () => {
    fs.rmSync(claudeFile);
    expect((await sync()).removed).toBe(1);
    expect(await search(['快照'])).toHaveLength(0);
  });
});

describe('writeAtomically', () => {
  const dir = () => fs.mkdtempSync(path.join(root, 'atomic-'));
  const tmpFiles = (d: string) => fs.readdirSync(d).filter((f) => f.endsWith('.tmp'));
  const realOps = () => ({
    mkdir: (p: string, o: { recursive: true }) => fs.promises.mkdir(p, o),
    writeFile: (p: string, t: string) => fs.promises.writeFile(p, t),
    rename: (a: string, b: string) => fs.promises.rename(a, b),
    rm: (p: string, o: { force: true }) => fs.promises.rm(p, o),
  });

  it('replaces the target and leaves no temp file on success', async () => {
    const d = dir();
    const file = path.join(d, 's.txt');
    fs.writeFileSync(file, 'old');
    await writeAtomically(file, 'new', realOps());
    expect(fs.readFileSync(file, 'utf8')).toBe('new');
    expect(tmpFiles(d)).toEqual([]);
  });

  it('removes a partially written temp file and rethrows the original error; target untouched', async () => {
    const d = dir();
    const file = path.join(d, 's.txt');
    fs.writeFileSync(file, 'old');
    const diskFull = Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
    const ops = {
      ...realOps(),
      // Leaves half the bytes behind, then fails — what a full disk looks like.
      writeFile: async (p: string, t: string) => {
        await fs.promises.writeFile(p, t.slice(0, 2));
        throw diskFull;
      },
    };
    // Retry a few times: nothing may accumulate.
    for (let i = 0; i < 3; i++) {
      await expect(writeAtomically(file, 'new content', ops)).rejects.toBe(diskFull);
    }
    expect(tmpFiles(d)).toEqual([]);
    expect(fs.readFileSync(file, 'utf8')).toBe('old');
  });

  it('removes the temp file when the rename fails', async () => {
    const d = dir();
    const file = path.join(d, 's.txt');
    const renameErr = new Error('EXDEV');
    await expect(
      writeAtomically(file, 'x', { ...realOps(), rename: async () => { throw renameErr; } }),
    ).rejects.toBe(renameErr);
    expect(tmpFiles(d)).toEqual([]);
  });

  it('a failing cleanup does not mask the original error', async () => {
    const d = dir();
    const file = path.join(d, 's.txt');
    const writeErr = new Error('EIO');
    const ops = {
      ...realOps(),
      writeFile: async () => { throw writeErr; },
      rm: async () => { throw new Error('cleanup failed'); },
    };
    await expect(writeAtomically(file, 'x', ops)).rejects.toBe(writeErr);
  });
});

describe('pure helpers', () => {
  it('parseSearchTerms splits alternatives, dedupes case-insensitively and caps', () => {
    expect(query.parseSearchTerms(['CSRF|csrf', ' 快照 ', ''])).toEqual(['CSRF', '快照']);
    expect(query.parseSearchTerms(Array.from({ length: 20 }, (_, i) => `t${i}`))).toHaveLength(query.MAX_SEARCH_TERMS);
    expect(query.parseSince('2026-09-01')).toBe(Date.parse('2026-09-01'));
    expect(query.parseSince('nope')).toBeNull();
  });

  it('header layout constants match what renderCorpusText writes', () => {
    const lines = live
      .renderCorpusText({ engine: 'claude', sessionId: 's', cwd: '/x', title: 't', updatedAt: 1 }, [
        { role: 'user', content: '#title: not a header' },
      ])
      .split('\n');
    expect(lines[live.CORPUS_HEADER_LINES - 1]).toBe(live.HEADER_END);
    expect(lines[live.CORPUS_TITLE_LINE - 1]).toBe('#title: t');
  });

  it('corpus header round-trips', () => {
    const text = live.renderCorpusText(
      { engine: 'codex', sessionId: 's', cwd: '/x', title: 'multi\nline', updatedAt: 42 },
      [{ role: 'user', content: 'hi' }],
    );
    expect(live.parseCorpusHeader(text)).toEqual({ engine: 'codex', sessionId: 's', cwd: '/x', title: 'multi line', updatedAt: 42 });
  });
});
