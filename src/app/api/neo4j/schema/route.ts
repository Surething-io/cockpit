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
      // Labels with counts
      const labelsResult = await session.run(
        'CALL db.labels() YIELD label RETURN label ORDER BY label'
      );
      const labels = labelsResult.records.map(r => r.get('label') as string);

      // Label counts (parallel)
      const labelCounts: Record<string, number> = {};
      for (const label of labels) {
        const countRes = await session.run(`MATCH (n:\`${label}\`) RETURN count(n) AS cnt`);
        const cnt = countRes.records[0]?.get('cnt');
        labelCounts[label] = cnt?.toNumber?.() ?? cnt ?? 0;
      }

      // Relationship types with counts
      const relTypesResult = await session.run(
        'CALL db.relationshipTypes() YIELD relationshipType RETURN relationshipType ORDER BY relationshipType'
      );
      const relTypes = relTypesResult.records.map(r => r.get('relationshipType') as string);

      const relCounts: Record<string, number> = {};
      for (const relType of relTypes) {
        const countRes = await session.run(`MATCH ()-[r:\`${relType}\`]->() RETURN count(r) AS cnt`);
        const cnt = countRes.records[0]?.get('cnt');
        relCounts[relType] = cnt?.toNumber?.() ?? cnt ?? 0;
      }

      // Property keys
      const propsResult = await session.run('CALL db.propertyKeys() YIELD propertyKey RETURN propertyKey ORDER BY propertyKey');
      const propertyKeys = propsResult.records.map(r => r.get('propertyKey') as string);

      // Indexes
      const indexResult = await session.run('SHOW INDEXES YIELD name, type, labelsOrTypes, properties, state');
      const indexes = indexResult.records.map(r => ({
        name: r.get('name'),
        type: r.get('type'),
        labelsOrTypes: r.get('labelsOrTypes'),
        properties: r.get('properties'),
        state: r.get('state'),
      }));

      // Constraints
      const constraintResult = await session.run('SHOW CONSTRAINTS YIELD name, type, labelsOrTypes, properties');
      const constraints = constraintResult.records.map(r => ({
        name: r.get('name'),
        type: r.get('type'),
        labelsOrTypes: r.get('labelsOrTypes'),
        properties: r.get('properties'),
      }));

      return NextResponse.json({
        labels: labels.map(l => ({ name: l, count: labelCounts[l] || 0 })),
        relationshipTypes: relTypes.map(r => ({ name: r, count: relCounts[r] || 0 })),
        propertyKeys,
        indexes,
        constraints,
      });
    } finally {
      await session.close();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
