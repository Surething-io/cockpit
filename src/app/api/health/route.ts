import { COCKPIT_DIR } from '@cockpit/shared-utils';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

// Liveness + identity probe used by the single-instance lock in server.mjs.
// `app` is the magic marker (distinguishes a real cockpit from any other service that
// happens to occupy the port); `home` is the data dir (confirms it's THIS data dir's
// instance, not merely some cockpit).
export async function GET() {
  return Response.json({
    app: 'cockpit',
    home: COCKPIT_DIR,
    pid: process.pid,
    port: Number(process.env.COCKPIT_PORT) || null,
    // COCKPIT_VERSION is set by server.mjs from package.json. The
    // npm_package_version fallback only ever has a value when the process was
    // launched through an npm script (`npm run dev`), which is why it cannot be
    // the primary source.
    version: process.env.COCKPIT_VERSION || process.env.npm_package_version || null,
    // Identifies the frontend build being served, so a long-lived browser tab
    // can tell it is holding chunks from a previous version after an upgrade.
    buildId: process.env.COCKPIT_BUILD_ID || null,
  });
}
