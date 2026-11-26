// Pull-request extraction in the transcript fold. Over a throwaway COCKPIT_HOME:
// paths.ts reads it at module load, so the env is set before the import.
import { describe, it, expect, beforeAll } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

process.env.COCKPIT_HOME = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'cockpit-pr-')), 'cockpit');

let live: typeof import('./transcriptIndexLive');
beforeAll(async () => {
  live = await import('./transcriptIndexLive');
});

const PR = 'https://github.com/Surething-io/ai-assistant/pull/5281';

const claudeCall = (id: string, command: string) => JSON.stringify({
  type: 'assistant', sessionId: 's1', timestamp: '2026-11-11T12:28:40.000Z',
  message: { model: 'm', content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] },
});
const claudeResult = (id: string, content: unknown, timestamp = '2026-11-11T12:28:44.000Z') => JSON.stringify({
  type: 'user', sessionId: 's1', timestamp,
  message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: id, content }] },
});
const claudePrompt = (text: string) => JSON.stringify({
  type: 'user', sessionId: 's1', timestamp: '2026-11-11T12:30:00.000Z', message: { role: 'user', content: text },
});
const codexExec = (command: string, output: string) => JSON.stringify({
  timestamp: '2026-11-11T12:28:44.710Z', type: 'event_msg',
  payload: { type: 'item_completed', item: { type: 'CommandExecution', command: ['/bin/zsh', '-lc', command], aggregated_output: output, exit_code: 0 } },
});

describe('transcript fold: pull requests', () => {
  it('pairs a claude gh pr create call with its result, across lines', () => {
    const state = live.emptyFoldState();
    live.foldClaudeLine(state, claudeCall('t1', `gh pr create --base main --title 'fix(slack): route threads' --body x`));
    expect(state.pullRequests).toEqual([]);
    live.foldClaudeLine(state, claudeResult('t1', `Creating pull request\n${PR}\n`));
    expect(state.pullRequests).toEqual([{
      url: PR, repo: 'Surething-io/ai-assistant', number: 5281,
      title: 'fix(slack): route threads', createdAt: '2026-11-11T12:28:44.000Z',
    }]);
    expect(state.pendingPrCreates).toEqual({});
  });

  it('reads block-array tool results and ignores PR links from other commands', () => {
    const state = live.emptyFoldState();
    live.foldClaudeLine(state, claudeCall('view', 'gh pr view 12 --json url'));
    live.foldClaudeLine(state, claudeResult('view', `{"url":"https://github.com/o/r/pull/12"}`));
    live.foldClaudeLine(state, claudeCall('t2', 'git push -u origin HEAD && gh pr create --fill'));
    live.foldClaudeLine(state, claudeResult('t2', [{ type: 'text', text: 'visit https://github.com/o/r/pull/new/feat\nhttps://github.com/o/r/pull/13' }]));
    expect(state.pullRequests.map((pr) => pr.number)).toEqual([13]);
    expect(state.pullRequests[0].title).toBeUndefined();
  });

  it('keeps the first sighting when the same PR is reported again', () => {
    const state = live.emptyFoldState();
    live.foldClaudeLine(state, claudeCall('a', `gh pr create -t "First"`));
    live.foldClaudeLine(state, claudeResult('a', PR));
    live.foldClaudeLine(state, claudeCall('b', `gh pr create -t "Again"`));
    live.foldClaudeLine(state, claudeResult('b', `a pull request for branch "x" already exists:\n${PR}`, '2026-11-12T00:00:00.000Z'));
    expect(state.pullRequests).toHaveLength(1);
    expect(state.pullRequests[0].title).toBe('First');
  });

  it('records codex CommandExecution results', () => {
    const state = live.emptyFoldState();
    live.foldCodexLine(state, codexExec(`gh pr create --base main --title 'fix: x' --body-file b.md`, `${PR}\n`));
    live.foldCodexLine(state, codexExec('gh pr list', 'https://github.com/o/r/pull/1\n'));
    expect(state.pullRequests).toEqual([{
      url: PR, repo: 'Surething-io/ai-assistant', number: 5281, title: 'fix: x', createdAt: '2026-11-11T12:28:44.710Z',
    }]);
    // Not a chat message: nothing leaks into the search corpus.
    expect(state.corpus).toEqual([]);
  });

  it('resolves a create whose output had no URL from a later lookup in the same turn', () => {
    // Shape of a real session: the push + create call hit its 120s timeout and moved to
    // the background, so its result is push noise; the agent then confirmed with gh pr list.
    const state = live.emptyFoldState();
    live.foldClaudeLine(state, claudeCall('t1', `git push -q -u origin feat/x; gh pr create --base main --title "feat(memory): rollout" --body-file - <<'EOF'\nbody\nEOF`));
    live.foldClaudeLine(state, claudeResult('t1', 'remote:      https://github.com/Surething-io/ai-assistant/security/dependabot\nCommand did not complete within its 120s timeout and was moved to the background (ID: b1).'));
    expect(state.pullRequests).toEqual([]);
    // Unrelated PR links in between do not count.
    live.foldClaudeLine(state, claudeCall('t2', 'gh pr list --json number,url'));
    live.foldClaudeLine(state, claudeResult('t2', '[{"number":1,"url":"https://github.com/o/r/pull/1"}]'));
    live.foldClaudeLine(state, claudeCall('t3', 'cat /tmp/b1.output | tail -3; gh pr list --head feat/x --json number,url'));
    live.foldClaudeLine(state, claudeResult('t3', `[{"number":5281,"url":"${PR}"}]`, '2026-11-11T12:31:00.000Z'));
    expect(state.pullRequests).toEqual([{
      url: PR, repo: 'Surething-io/ai-assistant', number: 5281,
      title: 'feat(memory): rollout', createdAt: '2026-11-11T12:28:44.000Z',
    }]);
    expect(state.unresolvedPrCreate).toBeNull();
    expect(state.pendingPrCreates).toEqual({});
    // Resolved once: a later view of another PR is just a mention.
    live.foldClaudeLine(state, claudeCall('t4', 'gh pr view 9'));
    live.foldClaudeLine(state, claudeResult('t4', 'https://github.com/o/r/pull/9'));
    expect(state.pullRequests).toHaveLength(1);
  });

  it('drops an unresolved create when the user starts a new turn', () => {
    const state = live.emptyFoldState();
    live.foldClaudeLine(state, claudeCall('t1', `gh pr create -t "x"`));
    live.foldClaudeLine(state, claudeResult('t1', 'pull request create failed: GraphQL error'));
    live.foldClaudeLine(state, claudePrompt('看下 #12'));
    live.foldClaudeLine(state, claudeCall('t2', 'gh pr view 12'));
    live.foldClaudeLine(state, claudeResult('t2', 'https://github.com/o/r/pull/12'));
    expect(state.pullRequests).toEqual([]);
  });

  it('resolves a URL-less codex create from a later lookup', () => {
    const state = live.emptyFoldState();
    live.foldCodexLine(state, codexExec(`gh pr create --title 'fix: y' --fill`, ''));
    live.foldCodexLine(state, codexExec('gh pr view --json url', `{"url":"${PR}"}`));
    expect(state.pullRequests.map((pr) => [pr.number, pr.title])).toEqual([[5281, 'fix: y']]);
  });
});
