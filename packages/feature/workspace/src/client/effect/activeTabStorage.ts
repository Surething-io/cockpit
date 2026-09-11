import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';

export type ActiveTabTarget =
  | { readonly kind: 'session'; readonly sessionId: string }
  | { readonly kind: 'blank' };

const keyFor = (cwd: string) => `cockpit:active-tab:${cwd}`;

export const loadActiveTabTarget = (
  cwd: string,
): Effect.Effect<ActiveTabTarget | null, AppError> =>
  Effect.try({
    try: () => {
      const raw = window.sessionStorage.getItem(keyFor(cwd));
      if (!raw) return null;
      const value = JSON.parse(raw) as Partial<ActiveTabTarget>;
      if (value.kind === 'blank') return { kind: 'blank' };
      if (value.kind === 'session' && typeof value.sessionId === 'string' && value.sessionId) {
        return { kind: 'session', sessionId: value.sessionId };
      }
      return null;
    },
    catch: (cause) => new AppError({ message: 'load active tab target failed', cause }),
  });

export const saveActiveTabTarget = (
  cwd: string,
  target: ActiveTabTarget,
): Effect.Effect<void, AppError> =>
  Effect.try({
    try: () => window.sessionStorage.setItem(keyFor(cwd), JSON.stringify(target)),
    catch: (cause) => new AppError({ message: 'save active tab target failed', cause }),
  });
