import { describe, expect, it } from 'vitest';
import { appendFileSync, mkdtempSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { codexToolUseId, resolveCodexCallId, resolveCodexPatchCallId, parsePatchFiles, createRolloutCallReader } from './codex';

const fnCall = (callId: string, cmd: string) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd }) } }) + '\n';
const patchCall = (callId: string, file: string) =>
  JSON.stringify({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'apply_patch', call_id: callId, input: `*** Begin Patch\n*** Update File: ${file}\n@@\n-a\n+b\n*** End Patch\n` } }) + '\n';
const noise = JSON.stringify({ type: 'response_item', payload: { type: 'reasoning', text: 'x' } }) + '\n';

describe('codexToolUseId', () => {
  it('prefers call_id so live snapshots match persisted Codex history', () => {
    expect(codexToolUseId({ id: 'item_1', call_id: 'call_1' })).toBe('call_1');
  });

  it('falls back to item id', () => {
    expect(codexToolUseId({ id: 'item_1' })).toBe('item_1');
  });
});

describe('resolveCodexCallId', () => {
  const calls = [
    { callId: 'call_A', cmd: 'echo AAA' },
    { callId: 'call_B', cmd: 'npm test -- pkg/a' },
    { callId: 'call_C', cmd: 'echo CCC > out.txt' },
  ];

  it('maps the index-th exec to its persistent call_id (live command is /bin/zsh wrapped)', () => {
    expect(resolveCodexCallId(calls, 0, "/bin/zsh -lc 'echo AAA'")).toBe('call_A');
    expect(resolveCodexCallId(calls, 2, "/bin/zsh -lc 'echo CCC > out.txt'")).toBe('call_C');
  });

  it('honours a resume offset via index (base + execSeen)', () => {
    // base=1 (one exec from a prior turn) + execSeen=1 → index 2
    expect(resolveCodexCallId(calls, 2, "/bin/zsh -lc 'echo CCC > out.txt'")).toBe('call_C');
  });

  it('unwraps double-quoted shell wrapper (codex uses " when the command contains \')', () => {
    const c = [{ callId: 'call_S', cmd: "sed -n '1,3p' README.zh.md" }];
    expect(resolveCodexCallId(c, 0, `/bin/zsh -lc "sed -n '1,3p' README.zh.md"`)).toBe('call_S');
  });

  it('unwraps single-quoted shell wrapper', () => {
    const c = [{ callId: 'call_T', cmd: 'tail -n 5 README.zh.md' }];
    expect(resolveCodexCallId(c, 0, "/bin/zsh -lc 'tail -n 5 README.zh.md'")).toBe('call_T');
  });

  it('tolerates truncated commands on either side (prefix match)', () => {
    expect(resolveCodexCallId(calls, 1, "/bin/zsh -lc 'npm test -- pkg/a --coverage'")).toBe('call_B');
    expect(resolveCodexCallId([{ callId: 'call_B', cmd: 'npm test -- pkg/a --coverage' }], 0, "/bin/zsh -lc 'npm test -- pkg/a'")).toBe('call_B');
  });

  it('falls back (null) on command desync so item.id is used instead', () => {
    expect(resolveCodexCallId(calls, 0, "/bin/zsh -lc 'rm -rf /'")).toBeNull();
  });

  it('falls back (null) when the entry is missing or has no call_id', () => {
    expect(resolveCodexCallId(calls, 9, "/bin/zsh -lc 'echo AAA'")).toBeNull();
    expect(resolveCodexCallId([{ cmd: 'echo AAA' }], 0, "/bin/zsh -lc 'echo AAA'")).toBeNull();
  });

  it('does not spuriously match a short command inside an unrelated long one (bounded includes)', () => {
    // persisted "ls" would be a substring of a long unrelated command; the length
    // bound must reject it so we fall back rather than bind the wrong call_id.
    const long = '/bin/zsh -lc "find . -name ls -type f | while read f; do echo $f; done"';
    expect(resolveCodexCallId([{ callId: 'call_X', cmd: 'ls' }], 0, long)).toBeNull();
  });
});

describe('parsePatchFiles', () => {
  it('extracts add/update/delete file paths from an apply_patch body', () => {
    const body = '*** Begin Patch\n*** Update File: a/b.ts\n@@\n-x\n+y\n*** Add File: c.md\n*** Delete File: d.txt\n*** End Patch\n';
    expect(parsePatchFiles(body)).toEqual(['a/b.ts', 'c.md', 'd.txt']);
  });
});

describe('resolveCodexPatchCallId', () => {
  const patches = [
    { callId: 'call_P0', files: ['README.zh.md'] },
    { callId: 'call_P1', files: ['src/a.ts', 'src/b.ts'] },
  ];

  it('maps the index-th patch by basename (live abs path vs rollout relative path)', () => {
    expect(resolveCodexPatchCallId(patches, 0, ['/repo/README.zh.md'])).toBe('call_P0');
    expect(resolveCodexPatchCallId(patches, 1, ['/repo/src/b.ts'])).toBe('call_P1');
  });

  it('trusts order when there is nothing to cross-check', () => {
    expect(resolveCodexPatchCallId([{ callId: 'call_P', files: [] }], 0, ['/x/y.ts'])).toBe('call_P');
    expect(resolveCodexPatchCallId(patches, 0, [])).toBe('call_P0');
  });

  it('falls back (null) on a file mismatch or missing/no-callId entry', () => {
    expect(resolveCodexPatchCallId(patches, 0, ['/repo/other.ts'])).toBeNull();
    expect(resolveCodexPatchCallId(patches, 9, ['/repo/README.zh.md'])).toBeNull();
    expect(resolveCodexPatchCallId([{ files: ['a'] }], 0, ['/x/a'])).toBeNull();
  });
});

describe('createRolloutCallReader', () => {
  const tmp = () => join(mkdtempSync(join(tmpdir(), 'codex-rollout-')), 'rollout.jsonl');

  it('accumulates exec and patch lists independently, in order', () => {
    const path = tmp();
    writeFileSync(path, noise + fnCall('call_1', 'echo A') + patchCall('call_P0', 'README.md'));
    const read = createRolloutCallReader();
    let r = read(path);
    expect(r.exec.map(c => c.callId)).toEqual(['call_1']);
    expect(r.patch.map(c => c.callId)).toEqual(['call_P0']);
    expect(r.patch[0].files).toEqual(['README.md']);
    // nothing appended → same lists
    r = read(path);
    expect(r.exec.length).toBe(1);
    expect(r.patch.length).toBe(1);
    // append more of both kinds
    appendFileSync(path, fnCall('call_2', 'echo B') + patchCall('call_P1', 'src/x.ts'));
    r = read(path);
    expect(r.exec.map(c => c.callId)).toEqual(['call_1', 'call_2']);
    expect(r.patch.map(c => c.callId)).toEqual(['call_P0', 'call_P1']);
  });

  it('carries a partial trailing line until its newline arrives', () => {
    const path = tmp();
    const line = fnCall('call_1', 'echo hello');
    writeFileSync(path, line.slice(0, 20)); // half a line, no newline yet
    const read = createRolloutCallReader();
    expect(read(path).exec).toEqual([]);
    appendFileSync(path, line.slice(20));
    expect(read(path).exec.map(c => c.callId)).toEqual(['call_1']);
  });

  it('re-scans from scratch if the file shrinks (truncate/rewrite)', () => {
    const path = tmp();
    writeFileSync(path, fnCall('call_1', 'echo A') + fnCall('call_2', 'echo B'));
    const read = createRolloutCallReader();
    expect(read(path).exec.length).toBe(2);
    writeFileSync(path, fnCall('call_9', 'echo Z'));
    expect(read(path).exec.map(c => c.callId)).toEqual(['call_9']);
  });
});
