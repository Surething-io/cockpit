import { Effect } from 'effect';
import { AppError } from '@cockpit/effect-core';

export const copyTextToClipboard = (text: string): Effect.Effect<void, AppError> =>
  Effect.tryPromise({
    try: () => navigator.clipboard.writeText(text),
    catch: (cause) => new AppError({ message: 'Failed to copy text to clipboard', cause }),
  });
