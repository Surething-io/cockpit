import { Effect } from 'effect';
import { handler, ok } from '@cockpit/effect-runtime/server';
import { GROK_MODEL_CATALOG } from '../../../shared/grokModels';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export const GET = handler(() => Effect.succeed(ok(GROK_MODEL_CATALOG)));
