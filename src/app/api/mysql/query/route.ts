import { NextRequest, NextResponse } from 'next/server';
import { mysqlPoolManager } from '@/lib/bubbles/mysql/MySQLPoolManager';

const MAX_ROWS = 1000;

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, sql, params } = await req.json();
    if (!id || !connectionString || !sql) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const pool = await mysqlPoolManager.getPool(id, connectionString);
    const start = performance.now();
    const [result, fieldPackets] = await pool.query(sql, params || []);
    const duration = Math.round((performance.now() - start) * 100) / 100;

    // SELECT-like queries return arrays
    if (Array.isArray(result) && Array.isArray(fieldPackets)) {
      const rows = result as Record<string, unknown>[];
      const fields = (fieldPackets as Array<{ name: string; columnType: number }>).map((f) => ({
        name: f.name,
        dataTypeID: f.columnType ?? 0,
      }));
      const truncated = rows.length > MAX_ROWS;
      return NextResponse.json({
        fields,
        rows: truncated ? rows.slice(0, MAX_ROWS) : rows,
        rowCount: rows.length,
        truncated,
        duration,
      });
    }

    // DML/DDL — result is ResultSetHeader
    const header = result as { affectedRows?: number; insertId?: number };
    return NextResponse.json({
      command: sql.trim().split(/\s+/)[0]?.toUpperCase() || 'QUERY',
      rowCount: header.affectedRows ?? 0,
      duration,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
