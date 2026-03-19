import { NextRequest, NextResponse } from 'next/server';
import { pgPoolManager } from '@/lib/bubbles/database/PgPoolManager';

export async function GET(req: NextRequest) {
  try {
    const sp = req.nextUrl.searchParams;
    const id = sp.get('id');
    const connectionString = sp.get('connectionString');
    const schema = sp.get('schema') || 'public';
    const table = sp.get('table');

    if (!id || !connectionString || !table) {
      return NextResponse.json({ error: 'Missing required params' }, { status: 400 });
    }

    const pool = await pgPoolManager.getPool(id, connectionString);

    const [colResult, pkResult, fkResult, idxResult] = await Promise.all([
      // Columns
      pool.query(
        `SELECT column_name, data_type, udt_name, is_nullable, column_default, character_maximum_length
         FROM information_schema.columns
         WHERE table_schema = $1 AND table_name = $2
         ORDER BY ordinal_position`,
        [schema, table],
      ),
      // Primary key columns
      pool.query(
        `SELECT kcu.column_name
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'PRIMARY KEY'
         ORDER BY kcu.ordinal_position`,
        [schema, table],
      ),
      // Foreign keys
      pool.query(
        `SELECT kcu.column_name, ccu.table_schema AS ref_schema, ccu.table_name AS ref_table, ccu.column_name AS ref_column
         FROM information_schema.table_constraints tc
         JOIN information_schema.key_column_usage kcu
           ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
         JOIN information_schema.constraint_column_usage ccu
           ON tc.constraint_name = ccu.constraint_name AND tc.table_schema = ccu.table_schema
         WHERE tc.table_schema = $1 AND tc.table_name = $2 AND tc.constraint_type = 'FOREIGN KEY'`,
        [schema, table],
      ),
      // Indexes
      pool.query(
        `SELECT indexname, indexdef FROM pg_indexes WHERE schemaname = $1 AND tablename = $2 ORDER BY indexname`,
        [schema, table],
      ),
    ]);

    const pkCols = new Set(pkResult.rows.map((r: { column_name: string }) => r.column_name));

    return NextResponse.json({
      columns: colResult.rows.map((r: { column_name: string; data_type: string; udt_name: string; is_nullable: string; column_default: string | null; character_maximum_length: number | null }) => ({
        name: r.column_name,
        type: r.data_type === 'USER-DEFINED' ? r.udt_name : r.data_type,
        nullable: r.is_nullable === 'YES',
        default: r.column_default,
        maxLength: r.character_maximum_length,
        isPrimaryKey: pkCols.has(r.column_name),
      })),
      primaryKeys: Array.from(pkCols),
      foreignKeys: fkResult.rows.map((r: { column_name: string; ref_schema: string; ref_table: string; ref_column: string }) => ({
        column: r.column_name,
        refSchema: r.ref_schema,
        refTable: r.ref_table,
        refColumn: r.ref_column,
      })),
      indexes: idxResult.rows.map((r: { indexname: string; indexdef: string }) => ({
        name: r.indexname,
        definition: r.indexdef,
      })),
    });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : String(e);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
