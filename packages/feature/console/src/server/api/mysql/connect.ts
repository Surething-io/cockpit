import { mysqlPoolManager } from '@cockpit/feature-console/server';

export async function POST(req: Request) {
  try {
    const { id, connectionString } = await req.json();
    if (!id || !connectionString) {
      return Response.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const pool = await mysqlPoolManager.getPool(id, connectionString);
    const conn = await pool.getConnection();
    try {
      const [[dbRow]] = await conn.query('SELECT DATABASE() AS db, VERSION() AS version') as [Array<{ db: string; version: string }>, unknown];
      const [dbRows] = await conn.query('SHOW DATABASES') as [Array<{ Database: string }>, unknown];
      const databases = dbRows
        .map((r) => r.Database)
        .filter((d) => !['information_schema', 'performance_schema', 'mysql', 'sys'].includes(d));
      return Response.json({
        database: dbRow.db,
        version: dbRow.version,
        schemas: databases,
      });
    } finally {
      conn.release();
    }
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
