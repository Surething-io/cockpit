import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = mkdtempSync(join(tmpdir(), 'cockpit-codex-edit-parity-'));
process.env.COCKPIT_HOME = join(root, 'cockpit');
process.env.HOME = join(root, 'home');
process.env.USERPROFILE = process.env.HOME;
let parser: typeof import('./transcriptParsers');
let edits: typeof import('./codexFork');
beforeAll(async () => { parser = await import('./transcriptParsers'); edits = await import('./codexFork'); });
afterAll(() => rmSync(root, { recursive: true, force: true }));
const encode = (value: unknown) => JSON.stringify(value);
const say = (role: string, text: string) => ({ type: 'response_item', payload: { type: 'message', role, content: [{ type: role === 'user' ? 'input_text' : 'output_text', text }] } });

describe('Codex displayed IDs select the same edit turn', () => {
  it.each(['# Check login', '<config>debug</config>'])('deletes and forks %s using actual parser IDs', async (prompt) => {
    const prompts = [prompt, `${prompt} again`, 'ordinary'];
    const lines = [
      { type: 'session_meta', payload: { id: 'parent', cwd: root } },
      say('user', '# AGENTS.md instructions for /example'),
      ...prompts.flatMap((text, i) => [
        { type: 'event_msg', payload: { type: 'task_started' } }, say('user', text),
        ...(i === 0 ? [] : [say('assistant', `reply ${i}`)]),
        { type: 'response_completed' },
      ]),
    ].map(encode);
    const parsed = await parser.parseCodexTranscriptFile({ text: lines.join('\n') + '\n' });
    expect(parsed.messages.filter((message) => message.role === 'user').map((message) => message.content)).toEqual(prompts);
    for (const message of parsed.messages) {
      const turn = message.role === 'user' ? prompts.indexOf(message.content) : Number(message.content.slice(-1));
      const deleted = edits.deleteCodexTurnLines(lines, message.id);
      expect(deleted.targetMissed).toBe(false);
      const remaining = await parser.parseCodexTranscriptFile({ text: deleted.newLines.join('\n') });
      expect(remaining.messages.filter((item) => item.role === 'user').map((item) => item.content)).toEqual(prompts.filter((_, i) => i !== turn));
      for (const scope of ['prefix', 'single'] as const) {
        const fork = edits.buildCodexForkLines(lines, 'parent', 'child', message.id, scope);
        expect(fork.targetMissed).toBe(false);
        const copied = await parser.parseCodexTranscriptFile({ text: fork.newLines.join('\n') });
        expect(copied.messages.filter((item) => item.role === 'user').map((item) => item.content)).toEqual(scope === 'prefix' ? prompts.slice(0, turn + 1) : [prompts[turn]]);
      }
    }
  });
});
