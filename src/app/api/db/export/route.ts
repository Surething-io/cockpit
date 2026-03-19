import { NextRequest, NextResponse } from 'next/server';
import { pgPoolManager } from '@/lib/bubbles/database/PgPoolManager';

function escapeCsvField(value: unknown): string {
  if (value === null || value === undefined) return '';
  const str = String(value);
  if (str.includes(',') || str.includes('"') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"';
  }
  return str;
}

export async function POST(req: NextRequest) {
  try {
    const { id, connectionString, sql, format } = await req.json();
    if (!id || !connectionString || !sql || !format) {
      return NextResponse.json({ error: 'Missing required fields' }, { status: 400 });
    }

    const pool = await pgPoolManager.getPool(id, connectionString);
    const result = await pool.query(sql);

    if (!result.rows || !result.fields) {
      return NextResponse.json({ error: 'Query did not return rows' }, { status: 400 });
    }

    const fields = result.fields.map((f: { name: string }) => f.name);

    if (format === 'json') {
      const body = JSON.stringify(result.rows, null, 2);
      return new NextResponse(body, {
        headers: {
          'Content-Type': 'application/json',
          'Content-Disposition': 'attachment; filename="export.json"',
        },
      });
    }

    // CSV
    const lines: string[] = [fields.map(escapeCsvField).join(',')];
    for (const row of result.rows) {
      lines.push(fields.map((f: string) => escapeCsvField(row[f])).join(','));
    }
    const body = lines.join('\n');
    return new NextResponse(body, {
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': 'attachment; filename="export.csv"',
      },
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
