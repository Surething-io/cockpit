import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

// The ACP mock from grokAcp/ plays Grok; no network, no real binary.
describe('suggestGrokTitle', () => {
  let home: string;
  let suggestGrokTitle: typeof import('./grokTitle').suggestGrokTitle;
  let serial = 0;
  beforeAll(async () => {
    home = await mkdtemp(join(tmpdir(), 'cockpit-grok-title-test-'));
    process.env.COCKPIT_HOME = home;
    ({ suggestGrokTitle } = await import('./grokTitle'));
  });
  afterAll(() => rm(home, { recursive: true, force: true }));

  const run = async (scenario: string) => {
    const trace = join(home, `trace-${serial++}.jsonl`);
    const text = await suggestGrokTitle(
      { cwd: home, sessionId: 'real-session', prompt: 'Name it', signal: new AbortController().signal },
      { binary: process.execPath, args: [resolve('packages/feature/agent/src/server/engines/grokAcp/mock-agent.mjs'), scenario, trace] },
    );
    const frames = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    return { text, frames };
  };

  it.each(['auth', 'v2'])('collects the reply on a throwaway session (%s), never the real one', async (scenario) => {
    const { text, frames } = await run(scenario);
    // Answer text only: thinking, a foreign child's text and an unrelated completion are ignored.
    expect(text).toBe('Hello 世界 done');
    const opened = frames.find((f) => f.method === 'session/new');
    expect(opened.params.cwd).not.toBe(home);
    expect(frames.some((f) => f.method === 'session/load' || f.method === 'session/resume')).toBe(false);
    expect(frames.find((f) => f.method === 'session/prompt').params.prompt[0].text).toBe('Name it');
    expect(() => process.kill(frames[0].pid, 0)).toThrow();
  });

  it('reports a failed prompt', async () => {
    await expect(run('error')).rejects.toThrow('Subscription quota exhausted');
  });

  it('stops at once when cancelled mid-handshake, and takes the child down', async () => {
    const trace = join(home, `trace-${serial++}.jsonl`);
    const controller = new AbortController();
    const started = Date.now();
    const running = suggestGrokTitle(
      { cwd: home, sessionId: 'real-session', prompt: 'Name it', signal: controller.signal },
      { binary: process.execPath, args: [resolve('packages/feature/agent/src/server/engines/grokAcp/mock-agent.mjs'), 'startup-hang', trace] },
    );
    const settled = running.catch((error: unknown) => error);
    await vi.waitFor(async () => expect(await readFile(trace, 'utf8')).toContain('initialize'));
    controller.abort();
    const error = await settled;
    expect(String(error)).toContain('cancelled');
    expect(Date.now() - started).toBeLessThan(10_000);
    const frames = (await readFile(trace, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(() => process.kill(frames[0].pid, 0)).toThrow();
    expect(frames.some((f) => f.method === 'session/new')).toBe(false);
  });
});
