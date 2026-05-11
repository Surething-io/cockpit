import { pgPoolManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString } = await req.json();
    if (!id || !connectionString) {
      return Response.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const pool = await pgPoolManager.getPool(id, connectionString);
    const client = await pool.connect();
    try {
      const [dbResult, schemaResult] = await Promise.all([
        client.query('SELECT current_database() AS db, version() AS version'),
        client.query(`SELECT schema_name FROM information_schema.schemata WHERE schema_name NOT IN ('pg_toast','pg_catalog','information_schema') ORDER BY schema_name`),
      ]);
      return Response.json({
        database: dbResult.rows[0].db,
        version: dbResult.rows[0].version,
        schemas: schemaResult.rows.map((r: { schema_name: string }) => r.schema_name),
      });
    } finally {
      client.release();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
