import type { MessageImage } from '@cockpit/shared-utils';
import { codexFilePath, extractCodexImageAttachments } from './codexTools';

/** Only explicit associations in user input can restore an upload; ambiguous paths fail closed. */
export function findCodexUploadImage(text: string, path: string): MessageImage | null {
  const target = codexFilePath(path);
  let found: MessageImage | null = null;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    const payload = entry?.payload;
    if (entry?.type !== 'response_item' || payload?.type !== 'message' || payload.role !== 'user' || !Array.isArray(payload.content)) continue;
    for (const attachment of extractCodexImageAttachments(payload.content)) {
      if (attachment.path !== target) continue;
      if (found && (found.media_type !== attachment.image.media_type || found.data !== attachment.image.data)) return null;
      found = attachment.image;
    }
  }
  return found;
}
