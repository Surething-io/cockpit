import { NextRequest, NextResponse } from 'next/server';
import { pgPoolManager } from '@/lib/bubbles/database/PgPoolManager';

const MAX_ROWS = 1000;

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, sql, params } = await req.json();
    if (!id || !connectionString || !sql) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const pool = await pgPoolManager.getPool(id, connectionString);
    const start = performance.now();
    const result = await pool.query(sql, params || []);
    const duration = Math.round((performance.now() - start) * 100) / 100;

    // SELECT-like queries return rows
    if (result.rows && result.fields) {
      const truncated = result.rows.length > MAX_ROWS;
      return NextResponse.json({
        fields: result.fields.map((f: { name: string; dataTypeID: number }) => ({ name: f.name, dataTypeID: f.dataTypeID })),
        rows: truncated ? result.rows.slice(0, MAX_ROWS) : result.rows,
        rowCount: result.rowCount,
        truncated,
        duration,
      });
    }

    // DML/DDL
    return NextResponse.json({
      command: result.command,
      rowCount: result.rowCount,
      duration,
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
