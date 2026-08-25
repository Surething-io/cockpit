import { describe, expect, it } from 'vitest';
import {
  CODEX_IMAGE_ONLY_TEXT,
  codexExecScriptCall,
  codexToolOutputText,
  extractCodexUserContent,
  normalizeCodexToolInput,
  normalizeCodexToolName,
  parseCodexExecScript,
} from './codexTools';

describe('normalizeCodexToolName', () => {
  it('maps Codex shell tool names to Bash', () => {
    expect(normalizeCodexToolName('shell_command')).toBe('Bash');
    expect(normalizeCodexToolName('exec_command')).toBe('Bash');
  });

  it('leaves non-shell tool names unchanged', () => {
    expect(normalizeCodexToolName('read_file')).toBe('read_file');
  });

  it('maps Codex shell cmd input to Bash command input', () => {
    expect(normalizeCodexToolInput('exec_command', { cmd: 'npm test' })).toEqual({
      command: 'npm test',
    });
    expect(normalizeCodexToolInput('shell_command', { command: 'npm test' })).toEqual({
      command: 'npm test',
    });
  });

  it('leaves non-shell tool input unchanged', () => {
    expect(normalizeCodexToolInput('read_file', { cmd: 'README.md' })).toEqual({
      cmd: 'README.md',
    });
  });

  it('extracts Codex user text and data-url images', () => {
    expect(extractCodexUserContent([
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/img.png">' },
      { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
      { type: 'input_text', text: '</image>what is this?' },
    ])).toEqual({
      text: 'what is this?',
      images: [{ type: 'base64', media_type: 'image/png', data: 'AAA' }],
    });
  });

  it('provides a shared placeholder for image-only Codex turns', () => {
    expect(CODEX_IMAGE_ONLY_TEXT).toBe('[Image]');
    expect(extractCodexUserContent([
      { type: 'input_text', text: '<image name=[Image #1] path="/tmp/img.png">' },
      { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' },
    ])).toEqual({
      text: '',
      images: [{ type: 'base64', media_type: 'image/jpeg', data: 'BBB' }],
    });
  });
});

describe('codex 5.6 exec script tool', () => {
  /**
   * The shape codex ACTUALLY writes: a JavaScript object literal with BARE
   * identifier keys. The older test below passes a JSON-shaped literal
   * (`{"cmd": …}`), which is why parsing this with JSON.parse stayed green in
   * CI while failing on 100% of real traffic — measured on one rollout, 659 of
   * 765 scripts came back `unknown` and not a single one as `exec`.
   */
  it('reads a shell call whose keys are bare identifiers', () => {
    const script = [
      'const r = await tools.exec_command({',
      '  cmd: "sed -n \'1,240p\' .agents/skills/explain/SKILL.md",',
      '  workdir: "/Users/ka/Work/x",',
      '  yield_time_ms: 10000,',
      '  max_output_tokens: 20000',
      '});',
      'text(r.output);',
    ].join('\n');
    expect(parseCodexExecScript(script)).toEqual({
      kind: 'exec',
      command: "sed -n '1,240p' .agents/skills/explain/SKILL.md",
      args: {
        cmd: "sed -n '1,240p' .agents/skills/explain/SKILL.md",
        workdir: '/Users/ka/Work/x',
        yield_time_ms: 10000,
        max_output_tokens: 20000,
      },
    });
    expect(codexExecScriptCall(script).name).toBe('Bash');
  });

  it('handles a trailing comma, nesting and every JS quote style', () => {
    const script = [
      'const r = await tools.exec_command({',
      "  cmd: 'echo hi',",
      '  `weird`: "ok",',
      '  env: { A: 1, B: [true, false, null] },',
      '  timeout: 1_000,',
      '});',
    ].join('\n');
    expect(parseCodexExecScript(script)).toEqual({
      kind: 'exec',
      command: 'echo hi',
      args: { cmd: 'echo hi', weird: 'ok', env: { A: 1, B: [true, false, null] }, timeout: 1000 },
    });
  });

  /**
   * A `:` or `}` inside a command string must not end the object early — the
   * reason this needs a string-aware scanner rather than a regex that quotes
   * bare keys.
   */
  it('is not confused by braces and colons inside the command', () => {
    const script =
      'await tools.exec_command({ cmd: "awk \'{print $1}\' f | sed \'s/a:b/c/\'", workdir: "/r" });';
    const parsed = parseCodexExecScript(script);
    expect(parsed).toMatchObject({ kind: 'exec', command: "awk '{print $1}' f | sed 's/a:b/c/'" });
  });

  it('still refuses to guess a command it cannot read statically', () => {
    // Real sample: the command is built by a loop over an array, so there is no
    // literal to read. Guessing here would bind the call to the wrong call_id.
    const script = [
      'const cmds = [["types", "pnpm --filter types check-types", 30000]];',
      'for (const [name, cmd, ms] of cmds) { await tools.exec_command({ cmd, yield_time_ms: ms }); }',
    ].join('\n');
    expect(parseCodexExecScript(script)).toEqual({ kind: 'unknown' });
  });

  it('names a non-exec tool carried by the exec script instead of faking Bash', () => {
    // 198 of 765 scripts in one real rollout were this. Under the old `unknown`
    // fallback every one rendered as a Bash bubble whose "command" was the JS
    // wrapper text.
    const script =
      'const r = await tools.write_stdin({session_id:48130, chars:"", yield_time_ms:30000});\ntext(JSON.stringify(r));\n';
    expect(parseCodexExecScript(script)).toEqual({
      kind: 'other',
      tool: 'write_stdin',
      args: { session_id: 48130, chars: '', yield_time_ms: 30000 },
    });
    expect(codexExecScriptCall(script).name).toBe('write_stdin');
  });

  it('maps update_plan carried by the exec script onto TodoWrite', () => {
    const script =
      'const p = await tools.update_plan({ explanation: "go", plan: [ { step: "a", status: "completed" }, { step: "b", status: "pending" } ] });';
    expect(codexExecScriptCall(script)).toEqual({
      name: 'TodoWrite',
      input: { todos: [{ content: 'a', status: 'completed' }, { content: 'b', status: 'pending' }] },
    });
  });

  it('reads a shell call out of the script body', () => {
    const script =
      'const r = await tools.exec_command({"cmd":"rg -n \'a b\' src","workdir":"/repo","yield_time_ms":10000}); text(r.output);\n';
    expect(parseCodexExecScript(script)).toEqual({
      kind: 'exec',
      command: "rg -n 'a b' src",
      args: { cmd: "rg -n 'a b' src", workdir: '/repo', yield_time_ms: 10000 },
    });
    expect(codexExecScriptCall(script)).toEqual({
      name: 'Bash',
      input: { command: "rg -n 'a b' src", workdir: '/repo', yield_time_ms: 10000 },
    });
  });

  it('reads an apply_patch body out of the script body', () => {
    const script = [
      'const patch = "*** Begin Patch\\n*** Update File: /repo/a.ts\\n@@\\n-const a = \\"1\\";\\n+const a = \\"2\\";\\n*** End Patch";',
      'text(await tools.apply_patch(patch));',
    ].join('\n');
    expect(parseCodexExecScript(script)).toEqual({
      kind: 'patch',
      patch: expect.stringContaining('*** Update File: /repo/a.ts'),
    });
    expect(codexExecScriptCall(script)).toEqual({
      name: 'ApplyPatch',
      input: { changes: [{ path: '/repo/a.ts', kind: 'update' }] },
    });
  });

  it('falls back to showing an unclassifiable script rather than dropping the call', () => {
    expect(parseCodexExecScript('text("hello");')).toEqual({ kind: 'unknown' });
    expect(codexExecScriptCall('text("hello");')).toEqual({
      name: 'Bash',
      input: { command: 'text("hello");' },
    });
  });

  it('flattens custom_tool_call_output content blocks into text', () => {
    expect(codexToolOutputText([
      { type: 'input_text', text: 'Script completed\n' },
      { type: 'input_text', text: 'done' },
    ])).toBe('Script completed\ndone');
    expect(codexToolOutputText('plain')).toBe('plain');
    expect(codexToolOutputText(undefined)).toBe('');
  });
});
