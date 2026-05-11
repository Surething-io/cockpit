import { neo4jManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString, cypher, params } = await req.json();
    if (!id || !connectionString || !cypher) {
      return Response.json({ error: 'Missing id, connectionString, or cypher' }, { status: 400 });
    }

    const result = await neo4jManager.runCypher(id, connectionString, cypher, params);
    return Response.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
