import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';
import type { SessionTitleChange } from '../../shared/sessionTitle';

export const requestSessionTitle = (cwd: string, sessionId: string, customTitle?: string | null) => Effect.tryPromise({
  try: async () => {
    const response = await fetch('/api/session-title', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, sessionId, ...(customTitle !== undefined ? { customTitle } : {}) }),
    });
    if (!response.ok) throw new Error(`Cannot ${customTitle === undefined ? 'read' : 'save'} session title (HTTP ${response.status})`);
    return await response.json() as SessionTitleChange;
  },
  catch: (cause) => new AppError({ message: 'Session title request failed', cause }),
});
