import { NextRequest, NextResponse } from 'next/server';
import { neo4jManager } from '@/lib/bubbles/neo4j/Neo4jManager';

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, cypher, params } = await req.json();
    if (!id || !connectionString || !cypher) {
      return NextResponse.json({ error: 'Missing id, connectionString, or cypher' }, { status: 400 });
    }

    const result = await neo4jManager.runCypher(id, connectionString, cypher, params);
    return NextResponse.json(result);
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
