import { join } from 'node:path';
import type { TranscriptFormat } from '@cockpit/effect-services';

export const noHistoryStashPath = (path: string) => join(path.replace(/\.jsonl$/, ''), 'nohistory-backup.jsonl');
export const CODEX_NO_HISTORY_SUFFIX = '.nohistory-backup';
export const codexNoHistoryStashPath = (path: string) => `${path}${CODEX_NO_HISTORY_SUFFIX}`;

/** Storage format and independent-task support are separate engine capabilities. */
export const transcriptFormat = (engine: string): TranscriptFormat => engine === 'codex' ? 'codex'
  : ['pi', 'ollama', 'kimi', 'deepseek', 'glm'].includes(engine) ? 'pi' : 'claude';

export const transcriptStashPath = (path: string, engine: string): string | null =>
  engine === 'claude' ? noHistoryStashPath(path) : engine === 'codex' ? codexNoHistoryStashPath(path) : null;
