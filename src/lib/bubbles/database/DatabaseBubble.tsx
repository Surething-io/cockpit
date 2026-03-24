'use client';

import React, { useState, useCallback, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { BUBBLE_CONTENT_HEIGHT } from '@/components/project/console/CommandBubble';
import { useToast } from '@/components/shared/Toast';
import { modKey } from '@/lib/platform';

// ============================================================================
// Types
// ============================================================================

interface TableInfo {
  name: string;
  type: 'table' | 'view';
  rowEstimate: number;
}

interface ColumnInfo {
  name: string;
  type: string;
  nullable: boolean;
  default: string | null;
  maxLength: number | null;
  isPrimaryKey: boolean;
}

interface ForeignKeyInfo {
  column: string;
  refSchema: string;
  refTable: string;
  refColumn: string;
}

interface IndexInfo {
  name: string;
  definition: string;
}

interface QueryField {
  name: string;
  dataTypeID: number;
}

interface QueryResult {
  fields: QueryField[];
  rows: Record<string, unknown>[];
  rowCount: number;
  truncated?: boolean;
  duration: number;
  // DML result
  command?: string;
}

type FilterOp = '=' | '!=' | '>' | '<' | '>=' | '<=' | 'LIKE' | 'NOT LIKE' | 'IN' | 'IS NULL' | 'IS NOT NULL';

const FILTER_OPS: { value: FilterOp; label: string }[] = [
  { value: '=', label: '=' },
  { value: '!=', label: '≠' },
  { value: '>', label: '>' },
  { value: '<', label: '<' },
  { value: '>=', label: '≥' },
  { value: '<=', label: '≤' },
  { value: 'LIKE', label: 'LIKE' },
  { value: 'NOT LIKE', label: 'NOT LIKE' },
  { value: 'IN', label: 'IN' },
  { value: 'IS NULL', label: 'IS NULL' },
  { value: 'IS NOT NULL', label: 'IS NOT NULL' },
];

interface ColumnFilter {
  op: FilterOp;
  value: string;
  enabled: boolean;
}

interface SortConfig {
  column: string;
  dir: 'ASC' | 'DESC';
}

// ============================================================================
// Helpers
// ============================================================================

const TOOLBAR_HEIGHT = 41;
const PAGE_SIZE = 50;

function formatTime(ts?: string): string {
  if (!ts) return '';
  const d = new Date(ts);
  if (isNaN(d.getTime())) return '';
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  const hours = String(d.getHours()).padStart(2, '0');
  const minutes = String(d.getMinutes()).padStart(2, '0');
  return `${month}-${day} ${hours}:${minutes}`;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/** 构建 WHERE 子句 + 参数数组 */
function buildWhereClause(filters: Record<string, ColumnFilter>): { where: string; params: unknown[] } {
  const parts: string[] = [];
  const params: unknown[] = [];
  let idx = 1;

  for (const [col, f] of Object.entries(filters)) {
    if (!f.enabled) continue;
    const q = quoteIdent(col);

    if (f.op === 'IS NULL') {
      parts.push(`${q} IS NULL`);
    } else if (f.op === 'IS NOT NULL') {
      parts.push(`${q} IS NOT NULL`);
    } else if (f.op === 'IN') {
      const vals = f.value.split(',').map(v => v.trim()).filter(Boolean);
      if (vals.length === 0) continue;
      const placeholders = vals.map(v => { params.push(v); return `$${idx++}`; });
      parts.push(`${q}::text IN (${placeholders.join(', ')})`);
    } else if (f.op === 'LIKE' || f.op === 'NOT LIKE') {
      parts.push(`${q}::text ${f.op} $${idx++}`);
      params.push(f.value);
    } else {
      parts.push(`${q}::text ${f.op} $${idx++}`);
      params.push(f.value);
    }
  }

  return { where: parts.length > 0 ? ` WHERE ${parts.join(' AND ')}` : '', params };
}

/** 将任意值转为显示字符串，处理对象/数组 */
function displayValue(v: unknown): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'object') return JSON.stringify(v);
  return String(v);
}

/** tooltip 用：JSON 美化展示 */
function tooltipValue(text: string): string {
  try {
    const parsed = JSON.parse(text);
    if (typeof parsed === 'object' && parsed !== null) return JSON.stringify(parsed, null, 2);
  } catch { /* not JSON */ }
  return text;
}

// ============================================================================
// CellTooltip — 自定义悬浮提示（替代 title 属性）
// ============================================================================

const TOOLTIP_MAX_W = 600;
const TOOLTIP_MARGIN = 8;

function CellTooltip({ text }: { text: string }) {
  const [show, setShow] = useState(false);
  const [pos, setPos] = useState({ x: 0, y: 0, maxW: TOOLTIP_MAX_W, maxH: 300, above: true });
  const wrapRef = useRef<HTMLSpanElement>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(null);
  const overTip = useRef(false);

  const scheduleHide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => {
      if (!overTip.current) setShow(false);
    }, 80);
  }, []);

  const handleCellEnter = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    overTip.current = false;
    timerRef.current = setTimeout(() => {
      const el = wrapRef.current;
      if (!el) return;
      // 未被截断则不弹 tooltip
      if (el.scrollWidth <= el.clientWidth) return;
      const rect = el.getBoundingClientRect();
      const vw = window.innerWidth;
      // 右边界不超出视口
      const maxW = Math.min(TOOLTIP_MAX_W, vw - rect.left - TOOLTIP_MARGIN);
      const x = maxW < 200 ? Math.max(TOOLTIP_MARGIN, vw - TOOLTIP_MAX_W - TOOLTIP_MARGIN) : rect.left;
      const finalMaxW = maxW < 200 ? Math.min(TOOLTIP_MAX_W, vw - TOOLTIP_MARGIN * 2) : maxW;
      // 比较上下可用空间，空间大的一侧弹出，并限制高度不溢出视口
      const vh = window.innerHeight;
      const spaceAbove = rect.top - TOOLTIP_MARGIN;
      const spaceBelow = vh - rect.bottom - TOOLTIP_MARGIN;
      const above = spaceAbove > spaceBelow && spaceAbove > 80;
      const y = above ? rect.top - 4 : rect.bottom + 4;
      const maxH = above ? spaceAbove - 4 : spaceBelow - 4;
      setPos({ x, y, maxW: finalMaxW, maxH: Math.max(60, maxH), above });
      setShow(true);
    }, 350);
  }, []);

  const handleCellLeave = useCallback(() => {
    scheduleHide();
  }, [scheduleHide]);

  const handleTipEnter = useCallback(() => {
    overTip.current = true;
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  const handleTipLeave = useCallback(() => {
    overTip.current = false;
    scheduleHide();
  }, [scheduleHide]);

  return (
    <span
      ref={wrapRef}
      className="block truncate"
      onMouseEnter={handleCellEnter}
      onMouseLeave={handleCellLeave}
    >
      {text}
      {show && createPortal(
        <div
          className="fixed z-[9999] overflow-y-auto px-2 py-1.5 text-xs font-mono bg-popover text-popover-foreground border border-border rounded shadow-lg whitespace-pre-wrap break-all select-text cursor-text"
          style={{ left: pos.x, top: pos.y, maxWidth: pos.maxW, maxHeight: pos.maxH, transform: pos.above ? 'translateY(-100%)' : undefined }}
          onMouseEnter={handleTipEnter}
          onMouseLeave={handleTipLeave}
        >
          {tooltipValue(text)}
        </div>,
        document.body
      )}
    </span>
  );
}

// ============================================================================
// API helpers
// ============================================================================

async function apiPost(path: string, body: Record<string, unknown>) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

async function apiGet(path: string, params: Record<string, string>) {
  const sp = new URLSearchParams(params);
  const res = await fetch(`${path}?${sp}`);
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

// ============================================================================
// DatabaseBubble
// ============================================================================

interface DatabaseBubbleProps {
  id: string;
  connectionString: string;
  displayName: string;
  selected: boolean;
  maximized: boolean;
  expandedHeight?: number;
  bubbleContentHeight?: number;
  onSelect: () => void;
  onClose: () => void;
  onToggleMaximize: () => void;
  timestamp?: string;
  onTitleMouseDown?: () => void;
}

type ActiveTab = 'structure' | 'data' | 'sql';

export function DatabaseBubble({
  id,
  connectionString,
  displayName,
  selected,
  maximized,
  expandedHeight,
  bubbleContentHeight,
  onSelect,
  onClose,
  onToggleMaximize,
  timestamp,
  onTitleMouseDown,
}: DatabaseBubbleProps) {
  const { showToast } = useToast();

  // Connection state
  const [status, setStatus] = useState<'connecting' | 'connected' | 'error'>('connecting');
  const [errorMsg, setErrorMsg] = useState('');
  const [schemas, setSchemas] = useState<string[]>([]);
  const [activeSchema, setActiveSchema] = useState('public');

  // Schema tree
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [selectedTable, setSelectedTable] = useState<string | null>(null);
  const [tableFilter, setTableFilter] = useState<'table' | 'view'>('table');
  const [activeTab, setActiveTab] = useState<ActiveTab>('data');

  // Table structure
  const [columns, setColumns] = useState<ColumnInfo[]>([]);
  const [primaryKeys, setPrimaryKeys] = useState<string[]>([]);
  const [foreignKeys, setForeignKeys] = useState<ForeignKeyInfo[]>([]);
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);

  // Data tab
  const [dataResult, setDataResult] = useState<QueryResult | null>(null);
  const [dataPage, setDataPage] = useState(0);
  const [dataLoading, setDataLoading] = useState(false);
  const [totalRows, setTotalRows] = useState(0);

  // Row selection
  const [selectedRows, setSelectedRows] = useState<Set<number>>(new Set());
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // Inline edit
  const [editingRowIdx, setEditingRowIdx] = useState<number | null>(null);
  const [editValues, setEditValues] = useState<Record<string, string>>({});
  const [isAddingRow, setIsAddingRow] = useState(false);
  const [newRowValues, setNewRowValues] = useState<Record<string, string>>({});

  // Filter & Sort
  const [filters, setFilters] = useState<Record<string, ColumnFilter>>({});
  const [sort, setSort] = useState<SortConfig | null>(null);

  // SQL tab
  const [sqlInput, setSqlInput] = useState('');
  const [sqlResult, setSqlResult] = useState<QueryResult | null>(null);
  const [sqlError, setSqlError] = useState('');
  const [sqlLoading, setSqlLoading] = useState(false);

  const sqlRef = useRef<HTMLTextAreaElement>(null);

  // ---- Connect on mount ----
  const connect = useCallback(async () => {
    setStatus('connecting');
    setErrorMsg('');
    try {
      const data = await apiPost('/api/db/connect', { id, connectionString });
      setSchemas(data.schemas || []);
      if (data.schemas?.length > 0 && !data.schemas.includes('public')) {
        setActiveSchema(data.schemas[0]);
      }
      setStatus('connected');
    } catch (e: unknown) {
      setErrorMsg(e instanceof Error ? e.message : String(e));
      setStatus('error');
    }
  }, [id, connectionString]);

  useEffect(() => { connect(); }, [connect]);

  // ---- Load tables when schema changes ----
  const loadTables = useCallback(async () => {
    if (status !== 'connected') return;
    try {
      const data = await apiGet('/api/db/schemas', { id, connectionString, schema: activeSchema });
      setTables(data.tables || []);
    } catch { /* ignore */ }
  }, [id, connectionString, activeSchema, status]);

  useEffect(() => { loadTables(); }, [loadTables]);

  // ---- Select table ----
  const selectTable = useCallback(async (tableName: string) => {
    setSelectedTable(tableName);
    setDataPage(0);
    setEditingRowIdx(null);
    setIsAddingRow(false);
    setSelectedRows(new Set());
    setConfirmingDelete(false);
    setFilters({});
    setSort(null);

    // Load columns
    try {
      const data = await apiGet('/api/db/columns', { id, connectionString, schema: activeSchema, table: tableName });
      setColumns(data.columns || []);
      setPrimaryKeys(data.primaryKeys || []);
      setForeignKeys(data.foreignKeys || []);
      setIndexes(data.indexes || []);
    } catch { /* ignore */ }

    // Load data
    loadTableData(tableName, 0, {}, null);
  }, [id, connectionString, activeSchema]);

  // ---- Load table data ----
  const loadTableData = useCallback(async (table: string, page: number, f?: Record<string, ColumnFilter>, s?: SortConfig | null) => {
    setDataLoading(true);
    const activeFilters = f ?? filters;
    const activeSort = s !== undefined ? s : sort;
    try {
      const from = `${quoteIdent(activeSchema)}.${quoteIdent(table)}`;
      const { where, params } = buildWhereClause(activeFilters);
      const orderBy = activeSort ? ` ORDER BY ${quoteIdent(activeSort.column)} ${activeSort.dir}` : '';
      const sql = `SELECT * FROM ${from}${where}${orderBy} LIMIT ${PAGE_SIZE} OFFSET ${page * PAGE_SIZE}`;
      const data = await apiPost('/api/db/query', { id, connectionString, sql, params });
      setDataResult(data);

      // Get total count with same filters
      const countSql = `SELECT count(*)::int AS cnt FROM ${from}${where}`;
      const countData = await apiPost('/api/db/query', { id, connectionString, sql: countSql, params });
      setTotalRows(countData.rows?.[0]?.cnt ?? 0);
    } catch { /* ignore */ }
    setDataLoading(false);
  }, [id, connectionString, activeSchema, filters, sort]);

  // ---- Execute SQL ----
  const executeSql = useCallback(async () => {
    if (!sqlInput.trim()) return;
    setSqlLoading(true);
    setSqlError('');
    setSqlResult(null);
    try {
      const data = await apiPost('/api/db/query', { id, connectionString, sql: sqlInput });
      setSqlResult(data);
    } catch (e: unknown) {
      setSqlError(e instanceof Error ? e.message : String(e));
    }
    setSqlLoading(false);
  }, [id, connectionString, sqlInput]);

  // ---- Inline edit: save ----
  const saveEdit = useCallback(async () => {
    if (editingRowIdx === null || !dataResult || !selectedTable) return;
    const row = dataResult.rows[editingRowIdx];
    const setClauses: string[] = [];
    const values: unknown[] = [];
    let paramIdx = 1;

    for (const col of columns) {
      if (editValues[col.name] !== undefined && editValues[col.name] !== displayValue(row[col.name] ?? '')) {
        setClauses.push(`${quoteIdent(col.name)} = $${paramIdx}`);
        values.push(editValues[col.name] === '' && col.nullable ? null : editValues[col.name]);
        paramIdx++;
      }
    }

    if (setClauses.length === 0) { setEditingRowIdx(null); return; }

    // WHERE clause using PK or all original values
    const whereCols = primaryKeys.length > 0 ? primaryKeys : columns.map(c => c.name);
    const whereParts: string[] = [];
    for (const col of whereCols) {
      if (row[col] === null || row[col] === undefined) {
        whereParts.push(`${quoteIdent(col)} IS NULL`);
      } else {
        whereParts.push(`${quoteIdent(col)} = $${paramIdx}`);
        values.push(row[col]);
        paramIdx++;
      }
    }

    const sql = `UPDATE ${quoteIdent(activeSchema)}.${quoteIdent(selectedTable)} SET ${setClauses.join(', ')} WHERE ${whereParts.join(' AND ')}`;
    try {
      await apiPost('/api/db/query', { id, connectionString, sql, params: values });
      setEditingRowIdx(null);
      loadTableData(selectedTable, dataPage, filters, sort);
    } catch (e: unknown) {
      alert(`Update failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [editingRowIdx, dataResult, selectedTable, columns, primaryKeys, editValues, id, connectionString, activeSchema, loadTableData, dataPage, filters, sort]);

  // ---- Insert row ----
  const saveNewRow = useCallback(async () => {
    if (!selectedTable) return;
    const colNames: string[] = [];
    const values: unknown[] = [];
    const placeholders: string[] = [];
    let paramIdx = 1;

    for (const col of columns) {
      if (newRowValues[col.name] !== undefined && newRowValues[col.name] !== '') {
        colNames.push(quoteIdent(col.name));
        values.push(newRowValues[col.name]);
        placeholders.push(`$${paramIdx}`);
        paramIdx++;
      }
    }

    if (colNames.length === 0) return;

    const sql = `INSERT INTO ${quoteIdent(activeSchema)}.${quoteIdent(selectedTable)} (${colNames.join(', ')}) VALUES (${placeholders.join(', ')})`;
    try {
      await apiPost('/api/db/query', { id, connectionString, sql, params: values });
      setIsAddingRow(false);
      setNewRowValues({});
      loadTableData(selectedTable, dataPage, filters, sort);
    } catch (e: unknown) {
      alert(`Insert failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selectedTable, columns, newRowValues, id, connectionString, activeSchema, loadTableData, dataPage, filters, sort]);

  // ---- Delete selected rows ----
  const deleteSelectedRows = useCallback(async () => {
    if (selectedRows.size === 0 || !dataResult || !selectedTable) return;

    const whereCols = primaryKeys.length > 0 ? primaryKeys : columns.map(c => c.name);
    let failCount = 0;

    for (const idx of Array.from(selectedRows).sort((a, b) => b - a)) {
      const row = dataResult.rows[idx];
      if (!row) continue;

      const whereParts: string[] = [];
      const values: unknown[] = [];
      let paramIdx = 1;

      for (const col of whereCols) {
        if (row[col] === null || row[col] === undefined) {
          whereParts.push(`${quoteIdent(col)} IS NULL`);
        } else {
          whereParts.push(`${quoteIdent(col)} = $${paramIdx}`);
          values.push(row[col]);
          paramIdx++;
        }
      }

      const safeSql = `DELETE FROM ${quoteIdent(activeSchema)}.${quoteIdent(selectedTable)} WHERE ctid = (SELECT ctid FROM ${quoteIdent(activeSchema)}.${quoteIdent(selectedTable)} WHERE ${whereParts.join(' AND ')} LIMIT 1)`;
      try {
        await apiPost('/api/db/query', { id, connectionString, sql: safeSql, params: values });
      } catch {
        failCount++;
      }
    }

    setSelectedRows(new Set());
    setConfirmingDelete(false);
    loadTableData(selectedTable, dataPage, filters, sort);
    if (failCount > 0) alert(`${failCount} 行删除失败`);
  }, [selectedRows, dataResult, selectedTable, primaryKeys, columns, id, connectionString, activeSchema, loadTableData, dataPage, filters, sort]);

  // ---- Export / Copy ----
  const handleExport = useCallback(async (format: 'csv' | 'json') => {
    if (!selectedTable) return;

    // When rows selected: copy selected rows to clipboard
    if (selectedRows.size > 0 && dataResult) {
      const fields = dataResult.fields.map(f => f.name);
      const rows = Array.from(selectedRows).sort((a, b) => a - b).map(i => dataResult.rows[i]).filter(Boolean);

      let text: string;
      if (format === 'json') {
        text = JSON.stringify(rows, null, 2);
      } else {
        const lines = [fields.join(',')];
        for (const row of rows) {
          lines.push(fields.map(f => {
            const v = row[f];
            if (v === null || v === undefined) return '';
            const s = typeof v === 'object' ? JSON.stringify(v) : String(v);
            return s.includes(',') || s.includes('"') || s.includes('\n') ? `"${s.replace(/"/g, '""')}"` : s;
          }).join(','));
        }
        text = lines.join('\n');
      }
      navigator.clipboard.writeText(text);
      return;
    }

    // No selection: download full table
    const sql = `SELECT * FROM ${quoteIdent(activeSchema)}.${quoteIdent(selectedTable)}`;
    try {
      const res = await fetch('/api/db/export', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, connectionString, sql, format }),
      });
      if (!res.ok) throw new Error('Export failed');
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${selectedTable}.${format}`;
      a.click();
      URL.revokeObjectURL(url);
    } catch (e: unknown) {
      alert(`Export failed: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, [selectedTable, id, connectionString, activeSchema, selectedRows, dataResult]);

  // ---- Cmd+Enter for SQL ----
  const handleSqlKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
      e.preventDefault();
      executeSql();
    }
  }, [executeSql]);

  // ---- Height calc ----
  const contentHeight = maximized && expandedHeight
    ? expandedHeight - TOOLBAR_HEIGHT
    : (bubbleContentHeight ?? BUBBLE_CONTENT_HEIGHT);

  // ---- Pagination ----
  const totalPages = Math.max(1, Math.ceil(totalRows / PAGE_SIZE));

  const goPage = useCallback((page: number) => {
    if (!selectedTable) return;
    setDataPage(page);
    loadTableData(selectedTable, page, filters, sort);
  }, [selectedTable, loadTableData, filters, sort]);

  // ---- Filter / Sort change handlers ----
  const handleFilterChange = useCallback((col: string, filter: ColumnFilter | null) => {
    const next = { ...filters };
    if (filter) next[col] = filter; else delete next[col];
    setFilters(next);
    setDataPage(0);
    setSelectedRows(new Set());
    if (selectedTable) loadTableData(selectedTable, 0, next, sort);
  }, [filters, sort, selectedTable, loadTableData]);

  const handleClearAllFilters = useCallback(() => {
    setFilters({});
    setDataPage(0);
    setSelectedRows(new Set());
    if (selectedTable) loadTableData(selectedTable, 0, {}, sort);
  }, [sort, selectedTable, loadTableData]);

  const handleSortChange = useCallback((s: SortConfig | null) => {
    setSort(s);
    setDataPage(0);
    setSelectedRows(new Set());
    if (selectedTable) loadTableData(selectedTable, 0, filters, s);
  }, [filters, selectedTable, loadTableData]);

  // ============================================================================
  // Render
  // ============================================================================

  return (
    <div className="flex flex-col items-start">
      <div
        className={`w-full bg-accent text-foreground
          relative transition-colors cursor-pointer
          ${maximized ? 'rounded-none overflow-visible border-0' : 'border overflow-hidden rounded-2xl rounded-bl-md rounded-br-md'}
          ${maximized ? '' : selected ? 'border-brand' : 'border-brand/30'}`}
        onClick={maximized ? undefined : onSelect}
      >
        {/* ---- Title Bar ---- */}
        <div
          data-drag-handle
          onDoubleClick={onToggleMaximize}
          onMouseDown={onTitleMouseDown}
          className={`flex items-center gap-2 px-4 py-1.5 border-b border-border ${maximized ? 'bg-card' : 'bg-card/50'}`}
          style={maximized ? { height: TOOLBAR_HEIGHT } : undefined}
        >
          <span className="text-sm flex-shrink-0">🐘</span>
          <span className="text-xs text-foreground truncate font-mono font-medium">{displayName}</span>
          {status === 'connecting' && (
            <span className="inline-block w-3 h-3 border border-brand border-t-transparent rounded-full animate-spin flex-shrink-0" />
          )}
          {status === 'error' && (
            <span className="text-[10px] text-destructive flex-shrink-0">连接失败</span>
          )}
          {status === 'connected' && (
            <span className="text-[10px] text-emerald-500 flex-shrink-0">已连接</span>
          )}
          <span className="flex-1" />
          {timestamp && (
            <span className="text-[10px] text-muted-foreground flex-shrink-0">{formatTime(timestamp)}</span>
          )}
          <button
            onClick={(e) => { e.stopPropagation(); onToggleMaximize(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            title={maximized ? `退出最大化 (${modKey()}M)` : `最大化 (${modKey()}M)`}
          >
            {maximized ? (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 3v3a2 2 0 01-2 2H3m18 0h-3a2 2 0 01-2-2V3m0 18v-3a2 2 0 012-2h3M3 16h3a2 2 0 012 2v3" />
              </svg>
            ) : (
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 8V4m0 0h4M4 4l5 5m11-1V4m0 0h-4m4 0l-5 5M4 16v4m0 0h4m-4 0l5-5m11 5l-5-5m5 5v-4m0 4h-4" />
              </svg>
            )}
          </button>
          <button
            onClick={(e) => { e.stopPropagation(); onClose(); }}
            className="p-0.5 rounded text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            title="关闭"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* ---- Body ---- */}
        <div style={{ height: contentHeight }} className="flex overflow-hidden">
          {status === 'connecting' && (
            <div className="flex-1 flex items-center justify-center text-sm text-muted-foreground">
              <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin mr-2" />
              连接中...
            </div>
          )}
          {status === 'error' && (
            <div className="flex-1 flex flex-col items-center justify-center gap-3 p-4">
              <span className="text-sm text-destructive text-center break-all">{errorMsg}</span>
              <button
                onClick={connect}
                className="px-3 py-1.5 text-xs bg-brand text-white rounded-md hover:bg-brand/90 transition-colors"
              >
                重试
              </button>
            </div>
          )}
          {status === 'connected' && (
            <>
              {/* Left sidebar */}
              <div className="w-52 flex-shrink-0 border-r border-border flex flex-col overflow-hidden">
                {/* Schema selector + refresh */}
                <div className="p-1.5 border-b border-border flex items-center gap-1">
                  {schemas.length > 1 ? (
                    <select
                      value={activeSchema}
                      onChange={(e) => { setActiveSchema(e.target.value); setSelectedTable(null); }}
                      className="flex-1 min-w-0 text-xs bg-background border border-input rounded px-1.5 py-1"
                    >
                      {schemas.map(s => <option key={s} value={s}>{s}</option>)}
                    </select>
                  ) : (
                    <span className="flex-1 min-w-0 text-xs text-muted-foreground truncate">{activeSchema}</span>
                  )}
                  <button
                    onClick={loadTables}
                    className="flex-shrink-0 w-5 h-5 flex items-center justify-center rounded text-muted-foreground hover:text-foreground hover:bg-accent active:bg-accent/50 transition-colors"
                    title="刷新表列表"
                  >
                    <svg width="12" height="12" viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round">
                      <path d="M1 1v5h5" /><path d="M15 15v-5h-5" />
                      <path d="M13.5 6A6 6 0 0 0 3.2 3.2L1 6" /><path d="M2.5 10a6 6 0 0 0 10.3 2.8L15 10" />
                    </svg>
                  </button>
                </div>
                {/* Type filter: T / V */}
                <div className="flex items-center border-b border-border">
                  {(['table', 'view'] as const).map(f => (
                    <button
                      key={f}
                      onClick={() => setTableFilter(f)}
                      className={`flex-1 py-1 text-[10px] font-medium transition-colors ${
                        tableFilter === f
                          ? 'text-brand border-b border-brand'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {{ table: 'T 表', view: 'V 视图' }[f]}
                    </button>
                  ))}
                </div>
                {/* Table list */}
                <div className="flex-1 overflow-y-auto text-xs">
                  {tables.filter(t => tableFilter === 'table' ? t.type !== 'view' : t.type === 'view').map(t => (
                    <div
                      key={t.name}
                      onClick={() => selectTable(t.name)}
                      className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer truncate transition-colors ${
                        selectedTable === t.name ? 'bg-brand/10 text-brand' : 'hover:bg-accent text-foreground'
                      }`}
                    >
                      <span className="flex-shrink-0 text-[10px] text-muted-foreground">{t.type === 'view' ? 'V' : 'T'}</span>
                      <span className="truncate min-w-0 flex-1"><CellTooltip text={t.name} /></span>
                      <span className="ml-auto text-[10px] text-muted-foreground flex-shrink-0">{t.rowEstimate > 0 ? `~${t.rowEstimate}` : ''}</span>
                    </div>
                  ))}
                  {tables.length === 0 && (
                    <div className="p-2 text-muted-foreground text-center">无表</div>
                  )}
                </div>
              </div>

              {/* Right main area */}
              <div className="flex-1 flex flex-col overflow-hidden min-w-0">
                {/* Tabs */}
                <div className="flex items-center gap-0 border-b border-border bg-card/30 flex-shrink-0">
                  {(['structure', 'data', 'sql'] as ActiveTab[]).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`px-3 py-1.5 text-xs transition-colors ${
                        activeTab === tab
                          ? 'text-brand border-b-2 border-brand font-medium'
                          : 'text-muted-foreground hover:text-foreground'
                      }`}
                    >
                      {{ structure: '结构', data: '数据', sql: 'SQL' }[tab]}
                    </button>
                  ))}
                  {/* Toolbar actions */}
                  {selectedTable && activeTab === 'data' && (
                    <div className="ml-auto flex items-center gap-1 pr-2">
                      {/* Filter indicator */}
                      {Object.values(filters).some(f => f.enabled) && (
                        <>
                          <span className="text-[10px] text-brand">
                            筛选: {Object.values(filters).filter(f => f.enabled).length}列
                          </span>
                          <button
                            onClick={handleClearAllFilters}
                            className="px-1 py-0.5 text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                            title="清除所有筛选"
                          >
                            ✕
                          </button>
                          <span className="text-border">|</span>
                        </>
                      )}
                      {selectedRows.size > 0 && !confirmingDelete && (
                        <button
                          onClick={() => setConfirmingDelete(true)}
                          className="px-1.5 py-0.5 text-[10px] text-destructive hover:text-destructive/80 bg-destructive/10 rounded transition-colors"
                        >
                          删除 {selectedRows.size} 行
                        </button>
                      )}
                      {confirmingDelete && (
                        <>
                          <span className="text-[10px] text-destructive">确认删除?</span>
                          <button
                            onClick={deleteSelectedRows}
                            className="px-1.5 py-0.5 text-[10px] text-white bg-destructive rounded transition-colors hover:bg-destructive/80"
                          >
                            确认
                          </button>
                          <button
                            onClick={() => setConfirmingDelete(false)}
                            className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted rounded transition-colors"
                          >
                            取消
                          </button>
                        </>
                      )}
                      <button
                        onClick={() => handleExport('csv')}
                        className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted rounded transition-colors"
                        title={selectedRows.size > 0 ? '复制选中行为 CSV' : '导出全表 CSV'}
                      >
                        {selectedRows.size > 0 ? '复制 CSV' : 'CSV'}
                      </button>
                      <button
                        onClick={() => handleExport('json')}
                        className="px-1.5 py-0.5 text-[10px] text-muted-foreground hover:text-foreground bg-muted rounded transition-colors"
                        title={selectedRows.size > 0 ? '复制选中行为 JSON' : '导出全表 JSON'}
                      >
                        {selectedRows.size > 0 ? '复制 JSON' : 'JSON'}
                      </button>
                    </div>
                  )}
                </div>

                {/* Tab content */}
                <div className="flex-1 overflow-auto">
                  {!selectedTable && activeTab !== 'sql' ? (
                    <div className="flex items-center justify-center h-full text-sm text-muted-foreground">
                      选择左侧表格
                    </div>
                  ) : activeTab === 'structure' ? (
                    <StructureView columns={columns} primaryKeys={primaryKeys} foreignKeys={foreignKeys} indexes={indexes} />
                  ) : activeTab === 'data' ? (
                    <DataView
                      result={dataResult}
                      loading={dataLoading}
                      columns={columns}
                      page={dataPage}
                      totalPages={totalPages}
                      totalRows={totalRows}
                      onPageChange={goPage}
                      filters={filters}
                      sort={sort}
                      onFilterChange={handleFilterChange}
                      onSortChange={handleSortChange}
                      selectedRows={selectedRows}
                      onSelectedRowsChange={(rows) => { setSelectedRows(rows); setConfirmingDelete(false); }}
                      editingRowIdx={editingRowIdx}
                      editValues={editValues}
                      onStartEdit={(idx) => {
                        if (!dataResult) return;
                        const row = dataResult.rows[idx];
                        const vals: Record<string, string> = {};
                        for (const col of columns) {
                          vals[col.name] = row[col.name] == null ? '' : displayValue(row[col.name]);
                        }
                        setEditValues(vals);
                        setEditingRowIdx(idx);
                      }}
                      onEditChange={(col, val) => setEditValues(prev => ({ ...prev, [col]: val }))}
                      onSaveEdit={saveEdit}
                      onCancelEdit={() => setEditingRowIdx(null)}
                      isAddingRow={isAddingRow}
                      newRowValues={newRowValues}
                      onStartAdd={() => { setIsAddingRow(true); setNewRowValues({}); }}
                      onNewRowChange={(col, val) => setNewRowValues(prev => ({ ...prev, [col]: val }))}
                      onSaveNewRow={saveNewRow}
                      onCancelAdd={() => { setIsAddingRow(false); setNewRowValues({}); }}
                      onCellCopy={(text) => { navigator.clipboard.writeText(text); showToast('已复制'); }}
                    />
                  ) : (
                    <SqlView
                      sqlInput={sqlInput}
                      onSqlChange={setSqlInput}
                      onExecute={executeSql}
                      onKeyDown={handleSqlKeyDown}
                      result={sqlResult}
                      error={sqlError}
                      loading={sqlLoading}
                      sqlRef={sqlRef}
                      onCellCopy={(text) => { navigator.clipboard.writeText(text); showToast('已复制'); }}
                    />
                  )}
                </div>
              </div>
            </>
          )}
        </div>

          {/* 底部状态栏 - 非放大模式 */}
          {!maximized && (
            <div className="border-t border-border px-4 py-1.5 flex items-center gap-2 text-xs text-muted-foreground">
              <span className={`inline-block w-2 h-2 rounded-full ${status === 'connected' ? 'bg-green-500' : status === 'error' ? 'bg-red-500' : 'bg-yellow-500 animate-pulse'}`} />
              <span>{{ connecting: '连接中', connected: '已连接', error: '连接失败' }[status]}</span>
              {status === 'connected' && selectedTable && (
                <span className="text-muted-foreground/70">{selectedTable}</span>
              )}
              <span className="flex-1" />
              {timestamp && <span className="text-[11px] flex-shrink-0">{formatTime(timestamp)}</span>}
            </div>
          )}
      </div>
    </div>
  );
}

// ============================================================================
// StructureView — 表结构展示
// ============================================================================

function StructureView({ columns, primaryKeys, foreignKeys, indexes }: {
  columns: ColumnInfo[];
  primaryKeys: string[];
  foreignKeys: ForeignKeyInfo[];
  indexes: IndexInfo[];
}) {
  if (columns.length === 0) {
    return <div className="p-4 text-sm text-muted-foreground">选择表以查看结构</div>;
  }
  return (
    <div className="p-2 space-y-3">
      {/* Columns */}
      <div>
        <div className="text-[10px] text-muted-foreground uppercase tracking-wide px-1 mb-1">列</div>
        <table className="w-full text-xs">
          <thead>
            <tr className="text-left text-muted-foreground border-b border-border">
              <th className="px-1.5 py-1 font-medium">名称</th>
              <th className="px-1.5 py-1 font-medium">类型</th>
              <th className="px-1.5 py-1 font-medium">可空</th>
              <th className="px-1.5 py-1 font-medium">默认值</th>
            </tr>
          </thead>
          <tbody>
            {columns.map(col => (
              <tr key={col.name} className="border-b border-border/50 hover:bg-accent/50">
                <td className="px-1.5 py-1 font-mono">
                  {col.isPrimaryKey && <span className="text-amber-500 mr-1" title="主键">🔑</span>}
                  {col.name}
                </td>
                <td className="px-1.5 py-1 text-muted-foreground font-mono">
                  {col.type}{col.maxLength ? `(${col.maxLength})` : ''}
                </td>
                <td className="px-1.5 py-1 text-muted-foreground">{col.nullable ? 'YES' : 'NO'}</td>
                <td className="px-1.5 py-1 text-muted-foreground font-mono truncate max-w-[120px]">{col.default || ''}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {/* Foreign Keys */}
      {foreignKeys.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide px-1 mb-1">外键</div>
          <div className="space-y-0.5">
            {foreignKeys.map((fk, i) => (
              <div key={i} className="text-xs font-mono px-1.5 text-muted-foreground">
                {fk.column} → {fk.refSchema}.{fk.refTable}.{fk.refColumn}
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Indexes */}
      {indexes.length > 0 && (
        <div>
          <div className="text-[10px] text-muted-foreground uppercase tracking-wide px-1 mb-1">索引</div>
          <div className="space-y-0.5">
            {indexes.map(idx => (
              <div key={idx.name} className="text-xs font-mono px-1.5 text-muted-foreground truncate" title={idx.definition}>
                {idx.name}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ============================================================================
// FilterDropdown — 列筛选下拉
// ============================================================================

function FilterDropdown({ filter, onApply, onClear, onToggle, onClose, colName, anchorRect }: {
  filter: ColumnFilter | null;
  onApply: (filter: ColumnFilter) => void;
  onClear: () => void;
  onToggle: (enabled: boolean) => void;
  onClose: () => void;
  colName: string;
  anchorRect: { left: number; bottom: number };
}) {
  const [op, setOp] = useState<FilterOp>(filter?.op || '=');
  const [value, setValue] = useState(filter?.value || '');
  const panelRef = useRef<HTMLDivElement>(null);

  // 点击外部关闭
  useEffect(() => {
    const handler = (e: MouseEvent) => {
      if (panelRef.current && !panelRef.current.contains(e.target as Node)) {
        onClose();
      }
    };
    document.addEventListener('mousedown', handler, true);
    return () => document.removeEventListener('mousedown', handler, true);
  }, [onClose]);

  const needsValue = op !== 'IS NULL' && op !== 'IS NOT NULL';

  const handleApply = () => {
    if (needsValue && !value.trim()) return;
    onApply({ op, value: value.trim(), enabled: true });
  };

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') { e.preventDefault(); handleApply(); }
  };

  // 计算位置
  const dropW = 220;
  const vw = typeof window !== 'undefined' ? window.innerWidth : 1000;
  let left = anchorRect.left;
  if (left + dropW > vw - 8) left = vw - dropW - 8;
  if (left < 8) left = 8;

  return createPortal(
    <div
      ref={panelRef}
      className="fixed z-[9998] w-[220px] bg-popover border border-border rounded-md shadow-lg p-2 space-y-2"
      style={{ left, top: anchorRect.bottom + 2 }}
      onClick={(e) => e.stopPropagation()}
    >
      {/* Header with toggle */}
      {filter && (
        <div className="flex items-center justify-between">
          <label className="flex items-center gap-1.5 text-[10px] text-muted-foreground cursor-pointer">
            <input
              type="checkbox"
              checked={filter.enabled}
              onChange={(e) => onToggle(e.target.checked)}
              className="w-3 h-3 accent-brand"
            />
            启用
          </label>
          <span className="text-[10px] text-muted-foreground font-mono truncate max-w-[120px]">{colName}</span>
        </div>
      )}
      {/* Operator select */}
      <select
        value={op}
        onChange={(e) => setOp(e.target.value as FilterOp)}
        className="w-full text-xs bg-background border border-input rounded px-1.5 py-1 focus:outline-none focus:ring-1 focus:ring-ring"
      >
        {FILTER_OPS.map(o => (
          <option key={o.value} value={o.value}>{o.label}</option>
        ))}
      </select>
      {/* Value input */}
      {needsValue && (
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder={op === 'IN' ? '逗号分隔多值' : op === 'LIKE' ? '%pattern%' : '值'}
          className="w-full text-xs bg-background border border-input rounded px-1.5 py-1 font-mono focus:outline-none focus:ring-1 focus:ring-ring"
          autoFocus
        />
      )}
      {/* Buttons */}
      <div className="flex items-center gap-1">
        <button
          onClick={handleApply}
          disabled={needsValue && !value.trim()}
          className="flex-1 px-2 py-1 text-[10px] bg-brand text-white rounded hover:bg-brand/90 disabled:opacity-40 transition-colors"
        >
          应用
        </button>
        {filter && (
          <button
            onClick={onClear}
            className="flex-1 px-2 py-1 text-[10px] text-muted-foreground bg-muted rounded hover:text-foreground transition-colors"
          >
            清除
          </button>
        )}
      </div>
    </div>,
    document.body
  );
}

// ============================================================================
// DataView — 数据浏览 + 选择 + 编辑
// ============================================================================

function DataView({
  result, loading, columns, page, totalPages, totalRows, onPageChange,
  filters, sort, onFilterChange, onSortChange,
  selectedRows, onSelectedRowsChange,
  editingRowIdx, editValues, onStartEdit, onEditChange, onSaveEdit, onCancelEdit,
  isAddingRow, newRowValues, onStartAdd, onNewRowChange, onSaveNewRow, onCancelAdd,
  onCellCopy,
}: {
  result: QueryResult | null;
  loading: boolean;
  columns: ColumnInfo[];
  page: number;
  totalPages: number;
  totalRows: number;
  onPageChange: (page: number) => void;
  filters: Record<string, ColumnFilter>;
  sort: SortConfig | null;
  onFilterChange: (col: string, filter: ColumnFilter | null) => void;
  onSortChange: (sort: SortConfig | null) => void;
  selectedRows: Set<number>;
  onSelectedRowsChange: (rows: Set<number>) => void;
  editingRowIdx: number | null;
  editValues: Record<string, string>;
  onStartEdit: (idx: number) => void;
  onEditChange: (col: string, val: string) => void;
  onSaveEdit: () => void;
  onCancelEdit: () => void;
  isAddingRow: boolean;
  newRowValues: Record<string, string>;
  onStartAdd: () => void;
  onNewRowChange: (col: string, val: string) => void;
  onSaveNewRow: () => void;
  onCancelAdd: () => void;
  onCellCopy: (text: string) => void;
}) {
  const [filterDropdownCol, setFilterDropdownCol] = useState<string | null>(null);
  const [filterAnchorRect, setFilterAnchorRect] = useState({ left: 0, bottom: 0 });

  // ESC 退出编辑模式 / 新增行模式 / 筛选下拉（必须在早返回之前，遵守 Hooks 规则）
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (filterDropdownCol !== null) { e.stopPropagation(); setFilterDropdownCol(null); }
        else if (editingRowIdx !== null) { e.stopPropagation(); onCancelEdit(); }
        else if (isAddingRow) { e.stopPropagation(); onCancelAdd(); }
      }
    };
    document.addEventListener('keydown', handler, true);
    return () => document.removeEventListener('keydown', handler, true);
  }, [filterDropdownCol, editingRowIdx, isAddingRow, onCancelEdit, onCancelAdd]);

  if (!result && !loading) {
    return <div className="p-4 text-sm text-muted-foreground">选择表以查看数据</div>;
  }

  const fields = result?.fields || [];
  const rows = result?.rows || [];

  // 列名 → 类型映射
  const colTypeMap: Record<string, string> = {};
  for (const c of columns) {
    colTypeMap[c.name] = c.type + (c.maxLength ? `(${c.maxLength})` : '');
  }

  const allSelected = rows.length > 0 && selectedRows.size === rows.length;
  const someSelected = selectedRows.size > 0 && !allSelected;

  const toggleAll = () => {
    if (allSelected) {
      onSelectedRowsChange(new Set());
    } else {
      onSelectedRowsChange(new Set(rows.map((_, i) => i)));
    }
  };

  const toggleRow = (idx: number) => {
    const next = new Set(selectedRows);
    if (next.has(idx)) next.delete(idx); else next.add(idx);
    onSelectedRowsChange(next);
  };

  const handleSortClick = (col: string) => {
    if (sort?.column === col) {
      if (sort.dir === 'ASC') onSortChange({ column: col, dir: 'DESC' });
      else onSortChange(null);
    } else {
      onSortChange({ column: col, dir: 'ASC' });
    }
  };

  return (
    <div className="flex flex-col h-full">
      {/* Table */}
      <div className="flex-1 overflow-auto relative">
        {loading && (
          <div className="absolute inset-0 bg-background/50 flex items-center justify-center z-10">
            <span className="inline-block w-4 h-4 border-2 border-brand border-t-transparent rounded-full animate-spin" />
          </div>
        )}
        <table className="w-full text-xs border-collapse">
          <thead className="sticky top-0 bg-card z-[2]">
            <tr>
              <th className="px-1 py-1 border-b border-border w-8 text-center">
                <input
                  type="checkbox"
                  checked={allSelected}
                  ref={(el) => { if (el) el.indeterminate = someSelected; }}
                  onChange={toggleAll}
                  className="w-3 h-3 accent-brand cursor-pointer"
                />
              </th>
              {fields.map(f => {
                const colSort = sort?.column === f.name ? sort.dir : null;
                const colFilter = filters[f.name];
                const hasFilter = colFilter?.enabled;
                return (
                  <th key={f.name} className="px-1.5 py-1 text-left text-muted-foreground font-medium border-b border-border whitespace-nowrap font-mono relative">
                    <span
                      className="cursor-pointer select-none hover:text-foreground transition-colors"
                      onClick={() => handleSortClick(f.name)}
                    >
                      {f.name}
                      {colTypeMap[f.name] && <span className="ml-1 text-[9px] text-muted-foreground/60 font-normal">{colTypeMap[f.name]}</span>}
                      {colSort === 'ASC' && <span className="ml-0.5 text-brand">↑</span>}
                      {colSort === 'DESC' && <span className="ml-0.5 text-brand">↓</span>}
                    </span>
                    <button
                      onClick={(e) => {
                        e.stopPropagation();
                        if (filterDropdownCol === f.name) { setFilterDropdownCol(null); return; }
                        const rect = (e.currentTarget as HTMLElement).closest('th')!.getBoundingClientRect();
                        setFilterAnchorRect({ left: rect.left, bottom: rect.bottom });
                        setFilterDropdownCol(f.name);
                      }}
                      className={`ml-1 inline-flex items-center transition-colors ${hasFilter ? 'text-brand' : 'text-muted-foreground/40 hover:text-muted-foreground'}`}
                    >
                      <svg className="w-2.5 h-2.5" viewBox="0 0 16 16" fill="currentColor"><path d="M1 2h14l-5.5 6.5V14l-3-2v-3.5z" /></svg>
                    </button>
                    {filterDropdownCol === f.name && (
                      <FilterDropdown
                        filter={colFilter || null}
                        onApply={(cf) => { onFilterChange(f.name, cf); setFilterDropdownCol(null); }}
                        onClear={() => { onFilterChange(f.name, null); setFilterDropdownCol(null); }}
                        onToggle={(enabled) => {
                          if (colFilter) onFilterChange(f.name, { ...colFilter, enabled });
                        }}
                        onClose={() => setFilterDropdownCol(null)}
                        colName={f.name}
                        anchorRect={filterAnchorRect}
                      />
                    )}
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody>
            {/* New row input */}
            {isAddingRow && (
              <tr className="bg-emerald-500/5">
                <td className="px-1 py-0.5 border-b border-border text-center">
                  <div className="flex gap-0.5 justify-center">
                    <button onClick={onSaveNewRow} className="text-[10px] text-emerald-500 hover:text-emerald-400" title="保存">✓</button>
                    <button onClick={onCancelAdd} className="text-[10px] text-muted-foreground hover:text-foreground" title="取消">✕</button>
                  </div>
                </td>
                {fields.map(f => (
                  <td key={f.name} className="px-0.5 py-0.5 border-b border-border">
                    <input
                      type="text"
                      value={newRowValues[f.name] ?? ''}
                      onChange={(e) => onNewRowChange(f.name, e.target.value)}
                      className="w-full px-1 py-0.5 text-xs bg-background border border-input rounded font-mono min-w-[60px]"
                      placeholder="NULL"
                    />
                  </td>
                ))}
              </tr>
            )}
            {rows.map((row, idx) => (
              <tr
                key={idx}
                className={`hover:bg-accent/50 ${selectedRows.has(idx) ? 'bg-brand/5' : ''} ${editingRowIdx === idx ? 'bg-blue-500/5' : ''}`}
              >
                <td className="px-1 py-0.5 border-b border-border/50 text-center">
                  {editingRowIdx === idx ? (
                    <div className="flex gap-0.5 justify-center">
                      <button onClick={onSaveEdit} className="text-[10px] text-emerald-500 hover:text-emerald-400" title="保存">✓</button>
                      <button onClick={onCancelEdit} className="text-[10px] text-muted-foreground hover:text-foreground" title="取消">✕</button>
                    </div>
                  ) : (
                    <input
                      type="checkbox"
                      checked={selectedRows.has(idx)}
                      onChange={() => toggleRow(idx)}
                      className="w-3 h-3 accent-brand cursor-pointer"
                    />
                  )}
                </td>
                {fields.map(f => (
                  <td
                    key={f.name}
                    className="px-1.5 py-0.5 border-b border-border/50 font-mono whitespace-nowrap max-w-[200px] truncate"
                    onDoubleClick={() => { if (editingRowIdx === null) onStartEdit(idx); }}
                    onContextMenu={(e) => { e.preventDefault(); onCellCopy(displayValue(row[f.name])); }}
                  >
                    {editingRowIdx === idx ? (
                      <input
                        type="text"
                        value={editValues[f.name] ?? ''}
                        onChange={(e) => onEditChange(f.name, e.target.value)}
                        className="w-full px-1 py-0.5 text-xs bg-background border border-input rounded font-mono min-w-[60px]"
                      />
                    ) : row[f.name] === null || row[f.name] === undefined ? (
                      <span className="text-muted-foreground italic">NULL</span>
                    ) : (
                      <CellTooltip text={displayValue(row[f.name])} />
                    )}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
        {rows.length === 0 && !loading && (
          <div className="p-4 text-xs text-muted-foreground text-center">无数据</div>
        )}
      </div>

      {/* Pagination + controls */}
      <div className="flex items-center justify-between px-2 py-1 border-t border-border text-[10px] text-muted-foreground bg-card/30 flex-shrink-0">
        <div className="flex items-center gap-2">
          <button
            onClick={onStartAdd}
            disabled={isAddingRow}
            className="px-1.5 py-0.5 text-[10px] text-emerald-500 hover:text-emerald-400 disabled:opacity-30"
          >
            + 新增行
          </button>
          <span>{totalRows} 行</span>
          {result?.duration !== undefined && <span>{result.duration}ms</span>}
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => onPageChange(page - 1)}
            disabled={page === 0}
            className="px-1 py-0.5 hover:text-foreground disabled:opacity-30"
          >
            ◀
          </button>
          <span>{page + 1} / {totalPages}</span>
          <button
            onClick={() => onPageChange(page + 1)}
            disabled={page >= totalPages - 1}
            className="px-1 py-0.5 hover:text-foreground disabled:opacity-30"
          >
            ▶
          </button>
        </div>
      </div>
    </div>
  );
}

// ============================================================================
// SqlView — SQL 编辑器
// ============================================================================

function SqlView({
  sqlInput, onSqlChange, onExecute, onKeyDown, result, error, loading, sqlRef, onCellCopy,
}: {
  sqlInput: string;
  onSqlChange: (val: string) => void;
  onExecute: () => void;
  onKeyDown: (e: React.KeyboardEvent) => void;
  result: QueryResult | null;
  error: string;
  loading: boolean;
  sqlRef: React.RefObject<HTMLTextAreaElement | null>;
  onCellCopy: (text: string) => void;
}) {
  return (
    <div className="flex flex-col h-full">
      {/* SQL Editor */}
      <div className="flex-shrink-0 p-2 border-b border-border">
        <textarea
          ref={sqlRef}
          value={sqlInput}
          onChange={(e) => onSqlChange(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={`输入 SQL... (${modKey()}Enter 执行)`}
          className="w-full h-20 px-2 py-1.5 text-xs font-mono bg-background border border-input rounded resize-y focus:outline-none focus:ring-1 focus:ring-ring"
          spellCheck={false}
        />
        <div className="flex items-center gap-2 mt-1">
          <button
            onClick={onExecute}
            disabled={loading || !sqlInput.trim()}
            className="px-2 py-1 text-xs bg-brand text-white rounded hover:bg-brand/90 disabled:opacity-50 transition-colors"
          >
            {loading ? '执行中...' : '▶ 执行'}
          </button>
          {result?.duration !== undefined && (
            <span className="text-[10px] text-muted-foreground">
              {result.command && !result.fields
                ? `${result.command} — ${result.rowCount} 行受影响 (${result.duration}ms)`
                : `${result.rows?.length ?? 0} 行 (${result.duration}ms)`
              }
              {result.truncated && ' [结果已截断至1000行]'}
            </span>
          )}
        </div>
      </div>

      {/* Error */}
      {error && (
        <div className="px-3 py-2 text-xs text-destructive bg-destructive/5 border-b border-border break-all">
          {error}
        </div>
      )}

      {/* Results */}
      {result?.fields && result.rows && (
        <div className="flex-1 overflow-auto">
          <table className="w-full text-xs border-collapse">
            <thead className="sticky top-0 bg-card z-[1]">
              <tr>
                {result.fields.map(f => (
                  <th key={f.name} className="px-1.5 py-1 text-left text-muted-foreground font-medium border-b border-border whitespace-nowrap font-mono">
                    {f.name}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, idx) => (
                <tr key={idx} className="hover:bg-accent/50">
                  {result.fields.map(f => (
                    <td
                      key={f.name}
                      className="px-1.5 py-0.5 border-b border-border/50 font-mono whitespace-nowrap max-w-[200px] truncate"
                      onContextMenu={(e) => { e.preventDefault(); onCellCopy(displayValue(row[f.name])); }}
                    >
                      {row[f.name] === null || row[f.name] === undefined ? (
                        <span className="text-muted-foreground italic">NULL</span>
                      ) : (
                        <CellTooltip text={displayValue(row[f.name])} />
                      )}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
