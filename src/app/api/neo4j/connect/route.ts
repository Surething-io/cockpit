import { NextRequest, NextResponse } from 'next/server';
import { neo4jManager } from '@/lib/bubbles/neo4j/Neo4jManager';

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString } = await req.json();
    if (!id || !connectionString) {
      return NextResponse.json({ error: 'Missing id or connectionString' }, { status: 400 });
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

      return NextResponse.json({
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
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
