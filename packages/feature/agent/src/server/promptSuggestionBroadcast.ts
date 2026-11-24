import { Effect } from 'effect';
import { WSError } from '@cockpit/effect-core';

export interface PromptSuggestionPush {
  sessionId: string;
  suggestion: string;
}

/**
 * Push a predicted next prompt to every window over the global-state socket.
 *
 * Used for suggestions produced after a run has ended (Codex, see
 * engines/codexSuggestion.ts): by then the run's own /ws/session-stream
 * subscription is closed, so the per-run event path cannot carry it. Same
 * transport and shape as broadcastSessionTitle.
 */
export const broadcastPromptSuggestion = (push: PromptSuggestionPush) => Effect.suspend(() => {
  const shared = globalThis as unknown as { __cockpitGlobalStateClients?: Set<{ readyState: number; send: (data: string) => void }> };
  const message = JSON.stringify({ type: 'prompt-suggestion', data: push });
  return Effect.forEach([...shared.__cockpitGlobalStateClients ?? []], (client) =>
    client.readyState !== 1 ? Effect.void : Effect.try({
      try: () => client.send(message),
      catch: (cause) => new WSError({ proto: 'global-state', kind: 'send', cause }),
    }).pipe(Effect.catchAll((cause) => Effect.logWarning('Prompt suggestion notification failed', cause))),
  { discard: true });
});
