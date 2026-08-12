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
