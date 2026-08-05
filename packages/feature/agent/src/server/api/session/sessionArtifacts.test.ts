import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';
import { copyReferencedArtifacts } from './sessionArtifacts';

const SRC = 'aaaaaaaa-1111-2222-3333-444444444444';
const DST = 'bbbbbbbb-5555-6666-7777-888888888888';
let projectDir: string;
let srcPath: string;
let dstPath: string;

const write = (p: string, body: string) => {
  fs.mkdirSync(join(p, '..'), { recursive: true });
  fs.writeFileSync(p, body);
};
const exists = (...seg: string[]) => fs.existsSync(join(projectDir, DST, ...seg));

beforeEach(() => {
  projectDir = fs.mkdtempSync(join(os.tmpdir(), 'artifacts-'));
  srcPath = join(projectDir, `${SRC}.jsonl`);
  dstPath = join(projectDir, `${DST}.jsonl`);
  fs.writeFileSync(srcPath, '');

  // Two subagents: only toolu_KEPT is referenced by the excerpted turn.
  for (const [agent, tool] of [['agent-a1', 'toolu_KEPT'], ['agent-a2', 'toolu_DROPPED']]) {
    write(join(projectDir, SRC, 'subagents', `${agent}.meta.json`), JSON.stringify({ toolUseId: tool }));
    write(join(projectDir, SRC, 'subagents', `${agent}.jsonl`), `{"agent":"${agent}"}\n`);
  }
  write(join(projectDir, SRC, 'tool-results', 'toolu_KEPT.txt'), 'kept output');
  write(join(projectDir, SRC, 'tool-results', 'toolu_DROPPED.txt'), 'other output');
  write(join(projectDir, SRC, 'workflows', 'wf_kept.json'), '{"runId":"wf_kept"}');
  write(join(projectDir, SRC, 'workflows', 'wf_other.json'), '{"runId":"wf_other"}');
  write(join(projectDir, SRC, 'subagents', 'workflows', 'wf_kept', 'agent-w1.jsonl'), '{"w":1}\n');
  write(join(projectDir, SRC, 'subagents', 'workflows', 'wf_other', 'agent-w9.jsonl'), '{"w":9}\n');
});
afterEach(() => fs.rmSync(projectDir, { recursive: true, force: true }));

/** One kept turn that used toolu_KEPT and a workflow whose run id is in the result text. */
const KEPT = [
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'tool_use', id: 'toolu_KEPT', name: 'Task' }] } }),
  JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_KEPT' }] } }),
  JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'started run wf_kept ok' }] } }),
];

describe('copyReferencedArtifacts', () => {
  it('brings across exactly what the kept transcript references', () => {
    const n = copyReferencedArtifacts(srcPath, dstPath, KEPT);

    expect(exists('subagents', 'agent-a1.jsonl')).toBe(true);
    expect(exists('subagents', 'agent-a1.meta.json')).toBe(true);
    expect(exists('tool-results', 'toolu_KEPT.txt')).toBe(true);
    expect(exists('workflows', 'wf_kept.json')).toBe(true);
    expect(exists('subagents', 'workflows', 'wf_kept', 'agent-w1.jsonl')).toBe(true);
    expect(n).toBe(5);
  });

  it('leaves unreferenced artifacts behind', () => {
    // An excerpt of one turn must not drag along the whole session's subagent history.
    copyReferencedArtifacts(srcPath, dstPath, KEPT);
    expect(exists('subagents', 'agent-a2.jsonl')).toBe(false);
    expect(exists('tool-results', 'toolu_DROPPED.txt')).toBe(false);
    expect(exists('workflows', 'wf_other.json')).toBe(false);
    expect(exists('subagents', 'workflows', 'wf_other', 'agent-w9.jsonl')).toBe(false);
  });

  it('copies content faithfully', () => {
    copyReferencedArtifacts(srcPath, dstPath, KEPT);
    expect(fs.readFileSync(join(projectDir, DST, 'subagents', 'agent-a1.jsonl'), 'utf-8')).toBe('{"agent":"agent-a1"}\n');
    expect(fs.readFileSync(join(projectDir, DST, 'tool-results', 'toolu_KEPT.txt'), 'utf-8')).toBe('kept output');
  });

  it('is a no-op when the source session has no artifact directory', () => {
    const bare = join(projectDir, 'cccccccc-0000-0000-0000-000000000000.jsonl');
    fs.writeFileSync(bare, '');
    expect(copyReferencedArtifacts(bare, dstPath, KEPT)).toBe(0);
  });

  it('copies nothing when the kept range references nothing', () => {
    const unrelated = [JSON.stringify({ type: 'user', message: { content: 'just a question' } })];
    expect(copyReferencedArtifacts(srcPath, dstPath, unrelated)).toBe(0);
    expect(fs.existsSync(join(projectDir, DST))).toBe(false);
  });

  it('is idempotent', () => {
    copyReferencedArtifacts(srcPath, dstPath, KEPT);
    expect(() => copyReferencedArtifacts(srcPath, dstPath, KEPT)).not.toThrow();
    expect(fs.readFileSync(join(projectDir, DST, 'subagents', 'agent-a1.jsonl'), 'utf-8')).toBe('{"agent":"agent-a1"}\n');
  });
});
