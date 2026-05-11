/**
 * Search endpoint — Cmd+K palette in the architecture map.
 *
 * GET /api/projectGraph/search?cwd=<abs>&q=<query>&limit=<int>
 *
 * Returns categorized hits (modules, files, symbols) with navigation targets
 * the client can plug straight into the drill state machine. Backed by the
 * cached project code index, so first hit may be slow (full project parse)
 * but subsequent searches are <10ms regardless of project size.
 */

import { getCodeIndex, searchIndex } from '@cockpit/feature-explorer/server/codeMap/projectGraph/codeIndex';
import { validateCwd } from '@cockpit/feature-explorer/server/files/shared';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const cwdParam = new URL(request.url).searchParams.get('cwd');
  const q = new URL(request.url).searchParams.get('q') ?? '';
  const limit = Math.min(
    Math.max(parseInt(new URL(request.url).searchParams.get('limit') ?? '15', 10) || 15, 1),
    100,
  );
  const cwdCheck = await validateCwd(cwdParam);
  if (!cwdCheck.ok) {
    return Response.json({ error: cwdCheck.reason }, { status: 400 });
  }
  const cwd = cwdCheck.abs;
  if (q.trim().length < 1) {
    return Response.json({ modules: [], files: [], symbols: [] });
  }

  try {
    const index = await getCodeIndex(cwd);
    return Response.json(searchIndex(index, q, limit));
  } catch (err) {
    console.error('[projectGraph/search] failed:', err);
    return Response.json(
      { error: err instanceof Error ? err.message : 'Search failed' },
      { status: 500 },
    );
  }
}
