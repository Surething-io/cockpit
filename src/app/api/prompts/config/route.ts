// `runtime` / `dynamic` are declared HERE, not re-exported: Next reads them by
// static analysis of the route file itself and silently falls back to defaults
// (with a build warning) if they arrive through a re-export.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Named re-export, NOT `export *`: a route module may only expose fields Next
// recognises, and the source module also exports `normalizePrompts` (kept
// exported so it can be unit-tested on its own). `export *` drags that along
// and the build fails with "not a valid Route export field".
export { GET, POST } from '@cockpit/feature-agent/server/api/prompts-config';
