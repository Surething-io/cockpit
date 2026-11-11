import { Effect } from 'effect';
import { encodePath } from '@cockpit/shared-utils';
import { cachedSessionTitle, readProjectTitles } from '../effect/sessionTitles';
import type { SessionTitleChange } from '../shared/sessionTitle';

/** Restore labels together with the session list, without resolving or reading transcripts. */
export const readCachedSessionTitles = (cwd: string, sessionIds: string[]) =>
  readProjectTitles(encodePath(cwd)).pipe(Effect.map((metadata): SessionTitleChange[] =>
    [...new Set(sessionIds)].flatMap((sessionId) => {
      const info = cachedSessionTitle(metadata, cwd, sessionId);
      return info ? [{ cwd, sessionId, ...info }] : [];
    })));
