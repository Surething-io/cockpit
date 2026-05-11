import { readFileSync } from 'fs';
import { join } from 'path';

export const runtime = 'nodejs';

export async function GET() {
  // server.mjs sets COCKPIT_ROOT to its own __dirname at boot. That's the
  // installed cockpit package root, which always contains its own
  // package.json — independent of where the user invoked `cock` from.
  // Falling back to process.cwd() preserves the historical behavior when
  // running via `npm run dev` straight from the source tree.
  const root = process.env.COCKPIT_ROOT || process.cwd();
  try {
    const pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf-8'));
    return Response.json({ version: pkg.version });
  } catch {
    return Response.json({ version: '' });
  }
}
