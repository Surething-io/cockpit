/** Symbol export or directory summary. Defaults to real functions and methods.
 * kind=all includes all real kinds; includeSynthetic opts into UI display blocks.
 * path is a relative directory. Repeat exclude for project-relative POSIX globs. */
import { Effect } from 'effect';
import { ValidationError } from '@cockpit/effect-core';
import { handler } from '@cockpit/effect-runtime/server';
import { validateCwd } from '../../files/shared';
import { getCodeIndex } from '../../codeMap/projectGraph/codeIndex';
import { indexQueryError } from '../../codeMap/projectGraph/indexFiles';
import { parseSymbolsOptions, symbolsFromIndex } from '../../codeMap/projectGraph/symbols';
import { indexResponse } from './indexResponse';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export const GET = handler(req => Effect.gen(function* () {
  const params = new URL(req.url).searchParams;
  const cwd = yield* Effect.promise(() => validateCwd(params.get('cwd')));
  if (!cwd.ok) return yield* Effect.fail(new ValidationError({ field: 'cwd', reason: cwd.reason }));
  const options = yield* Effect.try({
    try: () => parseSymbolsOptions(params),
    catch: cause => indexQueryError(cause, 'Invalid symbol export filters'),
  });
  return yield* Effect.tryPromise({
    try: async () => {
      const index = await getCodeIndex(cwd.abs);
      return indexResponse(index, symbolsFromIndex(index, options));
    },
    catch: cause => indexQueryError(cause, 'Symbol export failed'),
  });
}));
