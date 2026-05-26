// Re-export from @cockpit/feature-console/server. The handler logic lives
// in the package; this file is the Next.js mount point.
//
// Next.js requires `runtime` / `dynamic` to be statically-parseable LITERALS
// directly in the route file — re-exporting them via `export { dynamic }` fails
// Next's compile-time scan ("can't recognize the exported `dynamic` field").
// Declare them here directly and re-export only the route handlers.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
export {
  GET,
  POST,
} from '@cockpit/feature-console/server/api/terminal/bubble-order';
