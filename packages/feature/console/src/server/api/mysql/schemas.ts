import { mysqlPoolManager } from '@cockpit/feature-console/server';

export async function GET(req: Request) {
  try {
    const sp = new URL(req.url).searchParams;
    const id = sp.get('id');
    const connectionString = sp.get('connectionString');
    const schema = sp.get('schema');

    if (!id || !connectionString || !schema) {
      return Response.json({ error: 'Missing id, connectionString, or schema' }, { status: 400 });
    }

    const pool = await mysqlPoolManager.getPool(id, connectionString);
    const [rows] = await pool.query(
      `SELECT TABLE_NAME AS name,
              TABLE_TYPE AS type,
              TABLE_ROWS AS row_estimate
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = ?
       ORDER BY TABLE_NAME`,
      [schema],
    );

    return Response.json({
      tables: (rows as Array<{ name: string; type: string; row_estimate: number | null }>).map((r) => ({
        name: r.name,
        type: r.type === 'BASE TABLE' ? 'table' : 'view',
        rowEstimate: Math.max(0, Number(r.row_estimate ?? 0)),
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return Response.json({ error: msg }, { status: 500 });
  }
}
