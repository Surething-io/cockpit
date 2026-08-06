import { describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import { join } from 'path';

const sessionPaths = new Map<string, string>();

vi.mock('@cockpit/shared-utils', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@cockpit/shared-utils')>();
  return {
    ...actual,
    findCodexSessionPath: (sessionId: string) => sessionPaths.get(sessionId) || null,
  };
});

function writeCodexTranscript(sessionId: string, lines: unknown[]): string {
  const dir = fs.mkdtempSync(join(os.tmpdir(), 'codex-session-by-path-'));
  const filePath = join(dir, `${sessionId}.jsonl`);
  fs.writeFileSync(filePath, lines.map((line) => JSON.stringify(line)).join('\n') + '\n');
  sessionPaths.set(sessionId, filePath);
  return filePath;
}

describe('session-by-path codex history', () => {
  it('loads exec_command calls as Bash tool calls', async () => {
    const sessionId = 'codex-exec-command';
    writeCodexTranscript(sessionId, [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: 'run tests' }],
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call',
          name: 'exec_command',
          arguments: '{"cmd":"npm test"}',
          call_id: 'call_1',
        },
      },
      {
        type: 'response_item',
        payload: {
          type: 'function_call_output',
          call_id: 'call_1',
          output: 'ok',
        },
      },
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId }),
      })
    );
    const body = await response.json();

    expect(body.messages[1].toolCalls[0]).toMatchObject({
      id: 'call_1',
      name: 'Bash',
      input: { command: 'npm test' },
      result: 'ok',
      isLoading: false,
    });
  });

  it('loads Codex user images from input_image blocks', async () => {
    const sessionId = 'codex-input-image';
    writeCodexTranscript(sessionId, [
      {
        type: 'response_item',
        timestamp: '2026-08-06T08:40:49.243Z',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/tmp/img.png">' },
            { type: 'input_image', image_url: 'data:image/png;base64,AAA' },
            { type: 'input_text', text: 'explain this screenshot' },
          ],
        },
      },
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId }),
      })
    );
    const body = await response.json();

    expect(body.title).toBe('explain this screenshot');
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      content: 'explain this screenshot',
      images: [{ type: 'base64', media_type: 'image/png', data: 'AAA' }],
      timestamp: '2026-08-06T08:40:49.243Z',
    });
  });

  it('keeps image-only Codex user turns', async () => {
    const sessionId = 'codex-image-only';
    writeCodexTranscript(sessionId, [
      {
        type: 'response_item',
        payload: {
          type: 'message',
          role: 'user',
          content: [
            { type: 'input_text', text: '<image name=[Image #1] path="/tmp/img.png">' },
            { type: 'input_image', image_url: 'data:image/jpeg;base64,BBB' },
          ],
        },
      },
    ]);

    const { POST } = await import('./session-by-path');
    const response = await POST(
      new Request('http://test.local/api/session-by-path', {
        method: 'POST',
        body: JSON.stringify({ cwd: '/tmp', sessionId }),
      })
    );
    const body = await response.json();

    expect(body.title).toBe('[Image]');
    expect(body.messages[0]).toMatchObject({
      role: 'user',
      content: '',
      images: [{ type: 'base64', media_type: 'image/jpeg', data: 'BBB' }],
    });
  });
});
