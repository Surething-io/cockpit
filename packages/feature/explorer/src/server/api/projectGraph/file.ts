/**
 * File detail endpoint — symbol tree for the right-side function drawer.
 *
 * GET /api/projectGraph/file?cwd=<abs>&path=<rel>
 *
 * Returns the file's symbol tree (functions, classes, methods …) so the
 * Code Map canvas can render function-level children when the user expands
 * a file node, and so the drawer can list a file's symbols alongside the
 * code body of the one being viewed.
 *
 * Backed by the same code index as `/api/projectGraph`, so this is a cheap
 * projection from cached data after the first build for a given cwd.
 *
 * Status codes:
 *   200 — FileDetailResponse JSON
 *   400 — missing cwd / path
 *   404 — file is not in the index (unsupported language, beyond cap …)
 *   500 — build failed
 */

import {
  fileDetailFromIndex,
  getCodeIndex,
  invalidateIndex,
} from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';
import { validateCwd } from '@cockpit/feature-explorer/server/files/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cwdParam = new URL(request.url).searchParams.get('cwd');
  const filePath = new URL(request.url).searchParams.get('path');
  const cwdCheck = await validateCwd(cwdParam);
  if (!cwdCheck.ok) {
    return Response.json({ error: cwdCheck.reason }, { status: 400 });
  }
  const cwd = cwdCheck.abs;
  if (!filePath) {
    return Response.json({ error: 'Missing path parameter' }, { status: 400 });
  }

  try {
    const index = await getCodeIndex(cwd);
    const detail = fileDetailFromIndex(index, filePath);
    if (!detail) {
      return Response.json(
        {
          error: 'File not in index',
          hint: 'File may be an unsupported language or beyond the file cap.',
        },
        { status: 404 },
      );
    }
    return Response.json(detail);
  } catch (err) {
    console.error('[projectGraph/file] failed:', err);
    invalidateIndex(cwd);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Failed to load file detail' },
      { status: 500 },
    );
  }
}
