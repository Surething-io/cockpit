import { neo4jManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString } = await req.json();
    if (!id || !connectionString) {
      return Response.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const driver = await neo4jManager.getDriver(id, connectionString);
    const session = driver.session();
    try {
      // Get server info
      const info = await session.run('CALL dbms.components() YIELD name, versions, edition');
      const component = info.records[0];
      const version = component?.get('versions')?.[0] || 'unknown';
      const edition = component?.get('edition') || 'unknown';

      // Get counts
      const countResult = await session.run(
        'MATCH (n) WITH count(n) AS nodes MATCH ()-[r]->() RETURN nodes, count(r) AS relationships'
      );
      const counts = countResult.records[0];

      return Response.json({
        version,
        edition,
        nodeCount: counts?.get('nodes')?.toNumber?.() ?? counts?.get('nodes') ?? 0,
        relationshipCount: counts?.get('relationships')?.toNumber?.() ?? counts?.get('relationships') ?? 0,
      });
    } finally {
      await session.close();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
