import { describe, expect, it } from 'vitest';
import { CODEX_IMAGE_ONLY_TEXT, extractCodexUserContent, normalizeCodexToolInput, normalizeCodexToolName } from './codexTools';

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
