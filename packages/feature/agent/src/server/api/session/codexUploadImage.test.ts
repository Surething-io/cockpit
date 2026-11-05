import { describe, expect, it } from 'vitest';
import { pathToFileURL } from 'node:url';
import { codexFilePath, codexItemBubble, extractCodexImageAttachments, normalizeCodexToolInput } from './codexTools';
import { findCodexUploadImage } from './codexUploadImage';

const image = (data = 'YWJj') => ({ type: 'input_image', image_url: `data:image/png;base64,${data}` });
const text = (text: string) => ({ type: 'input_text', text });
const upload = (path: string, data = 'YWJj') => [text(`<image name=[Image #1] path="${path}">`), image(data), text('</image>')];
const row = (content: unknown[], role = 'user') => JSON.stringify({ type: 'response_item', payload: { type: 'message', role, content } });

describe('Codex file path boundary', () => {
  it('normalizes encoded file URLs in current and legacy image tools', () => {
    const path = '/tmp/截图 with space.png';
    const uri = pathToFileURL(path).href;
    for (const type of ['ImageView', 'image_view']) {
      expect(codexItemBubble({ type, id: 'img', path: uri })?.input).toEqual({ file_path: path });
    }
    expect(normalizeCodexToolInput('view_image', { path: uri })).toEqual({ file_path: path });
    expect(codexFilePath(path)).toBe(path);
  });

  it('leaves malformed file URLs readable as tool input without aborting history', () => {
    expect(codexFilePath('file://%')).toBe('file://%');
    expect(codexItemBubble({ type: 'image_view', id: 'bad', path: 'file://%' })?.input).toEqual({ file_path: 'file://%' });
  });
});

describe('Codex upload associations', () => {
  it('pairs multiple uploads and leaves unlabelled images unassociated', () => {
    const attachments = extractCodexImageAttachments([...upload('/tmp/a.png'), image(), ...upload('/tmp/b.png', 'ZGVm')]);
    expect(attachments.map((a) => a.path)).toEqual(['/tmp/a.png', undefined, '/tmp/b.png']);
    expect(attachments.map((a) => a.image.data)).toEqual(['YWJj', 'YWJj', 'ZGVm']);
  });

  it.each([
    [text('<image path="/tmp/a.png">'), image()],
    [text('<image path="/tmp/a.png">'), image(), image(), text('</image>')],
    [text('<image path="/tmp/a.png"><image path="/tmp/b.png">'), image(), text('</image></image>')],
    [text('<image path="/tmp/a.png">unexpected text'), image(), text('</image>')],
    [text('<image path="/tmp/a.png">'), image(), text('unexpected text</image>')],
  ])('does not guess a path from incomplete or ambiguous markup: %j', (...content) => {
    expect(extractCodexImageAttachments(content).every((a) => a.path === undefined)).toBe(true);
  });

  it('finds earlier and steered uploads across the full transcript and ignores other roles', () => {
    const transcript = [row(upload('/tmp/a.png')), row([text('later prompt')]), row(upload('/tmp/b.png', 'ZGVm')), row(upload('/tmp/a.png', 'wrong'), 'assistant')].join('\n');
    expect(findCodexUploadImage(transcript, 'file:///tmp/a.png')?.data).toBe('YWJj');
    expect(findCodexUploadImage(transcript, '/tmp/b.png')?.data).toBe('ZGVm');
    expect(findCodexUploadImage(transcript, '/elsewhere/a.png')).toBeNull();
  });

  it('accepts repeated identical records but rejects conflicting associations', () => {
    const first = row(upload('/tmp/a.png'));
    expect(findCodexUploadImage(`${first}\n${first}`, '/tmp/a.png')?.data).toBe('YWJj');
    expect(findCodexUploadImage(`${first}\n${row(upload('/tmp/a.png', 'ZGVm'))}`, '/tmp/a.png')).toBeNull();
  });

  it('ignores malformed lines and a partially appended final record', () => {
    expect(findCodexUploadImage(`not-json\n${row(upload('/tmp/a.png'))}\n{"payload":`, '/tmp/a.png')?.data).toBe('YWJj');
  });
});
