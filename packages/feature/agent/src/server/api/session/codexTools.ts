import type { ImageMediaType, MessageImage } from '@cockpit/shared-utils';

export const CODEX_IMAGE_ONLY_TEXT = '[Image]';

export function normalizeCodexToolName(name: string): string {
  if (name === 'shell_command' || name === 'exec_command') return 'Bash';
  if (name === 'apply_patch') return 'ApplyPatch';
  return name;
}

/**
 * Parse an apply_patch body into a `{ changes: [{path, kind}] }` input, matching the
 * shape the live codex engine emits for `file_change` items so the bubble renders the
 * same way whether streamed live or rebuilt on resume.
 */
export function parseCodexPatchInput(input: string): { changes: Array<{ path: string; kind: string }> } {
  const changes: Array<{ path: string; kind: string }> = [];
  const re = /^\*\*\* (Add|Update|Delete) File: (.+)$/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(input))) {
    changes.push({ path: m[2].trim(), kind: m[1].toLowerCase() });
  }
  return { changes };
}

export function normalizeCodexToolInput(
  name: string,
  input: Record<string, unknown>
): Record<string, unknown> {
  if (normalizeCodexToolName(name) !== 'Bash') return input;
  if (typeof input.command === 'string') return input;
  if (typeof input.cmd !== 'string') return input;

  const { cmd: _cmd, ...rest } = input;
  return { ...rest, command: input.cmd };
}

interface CodexContentBlock {
  type?: string;
  text?: string;
  image_url?: string;
}

const CODEX_IMAGE_TAG_RE = /^<image\b[^>]*>$/i;
const CODEX_IMAGE_MARKUP_RE = /<\/?image\b[^>]*>/gi;
const DATA_IMAGE_URL_RE = /^data:(image\/(?:png|jpeg|webp|gif));base64,([\s\S]*)$/;

function parseCodexImageUrl(imageUrl: string): MessageImage | null {
  const match = imageUrl.match(DATA_IMAGE_URL_RE);
  if (!match) return null;

  return {
    type: 'base64',
    media_type: match[1] as ImageMediaType,
    data: match[2],
  };
}

export function extractCodexUserContent(content: CodexContentBlock[] | undefined): {
  text: string;
  images: MessageImage[];
} {
  const text = (content
    ?.filter(c => c.type === 'input_text' && c.text && !CODEX_IMAGE_TAG_RE.test(c.text.trim()))
    .map(c => c.text!)
    .join('') || '').replace(CODEX_IMAGE_MARKUP_RE, '');
  const images = content
    ?.filter(c => c.type === 'input_image' && c.image_url)
    .map(c => parseCodexImageUrl(c.image_url!))
    .filter((image): image is MessageImage => image !== null) || [];

  return { text, images };
}
