import { NextRequest, NextResponse } from 'next/server';
import { pgPoolManager } from '@/lib/db/PgPoolManager';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const id = sp.get('id');
    const connectionString = sp.get('connectionString');
    const schema = sp.get('schema') || 'public';

    if (!id || !connectionString) {
      return NextResponse.json({ error: 'Missing id or connectionString' }, { status: 400 });
    }

    const pool = await pgPoolManager.getPool(id, connectionString);
    const result = await pool.query(
      `SELECT t.table_name AS name,
              t.table_type AS type,
              COALESCE(c.reltuples, 0)::bigint AS row_estimate
       FROM information_schema.tables t
       LEFT JOIN pg_class c ON c.relname = t.table_name
         AND c.relnamespace = (SELECT oid FROM pg_namespace WHERE nspname = t.table_schema)
       WHERE t.table_schema = $1
       ORDER BY t.table_name`,
      [schema],
    );

    return NextResponse.json({
      tables: result.rows.map((r: { name: string; type: string; row_estimate: string }) => ({
        name: r.name,
        type: r.type === 'BASE TABLE' ? 'table' : 'view',
        rowEstimate: Math.max(0, Number(r.row_estimate)),
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
