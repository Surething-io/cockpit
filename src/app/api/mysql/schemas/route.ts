import { NextRequest, NextResponse } from 'next/server';
import { mysqlPoolManager } from '@/lib/bubbles/mysql/MySQLPoolManager';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const id = sp.get('id');
    const connectionString = sp.get('connectionString');
    const schema = sp.get('schema');

    if (!id || !connectionString || !schema) {
      return NextResponse.json({ error: 'Missing id, connectionString, or schema' }, { status: 400 });
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

    return NextResponse.json({
      tables: (rows as Array<{ name: string; type: string; row_estimate: number | null }>).map((r) => ({
        name: r.name,
        type: r.type === 'BASE TABLE' ? 'table' : 'view',
        rowEstimate: Math.max(0, Number(r.row_estimate ?? 0)),
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
