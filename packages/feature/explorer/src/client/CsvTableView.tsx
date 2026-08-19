'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { ChevronDown, ChevronUp, Search, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

/**
 * RFC 4180 CSV/TSV parsing + table rendering.
 *
 * Lives in explorer because rendering a file's content is this package's
 * domain (same reason CodeViewer / InteractiveMarkdownPreview do). The file
 * browser embeds this view directly; chat opens it via CsvPreviewModal.
 */

/** Rows shown per chunk. A generated metrics CSV can be tens of thousands of
 *  rows — rendering them all would freeze the modal on open, so the tail is
 *  revealed on demand instead of virtualized (the table has no fixed row
 *  height: cells wrap). */
const ROWS_PER_CHUNK = 500;

/**
 * Split delimited text into rows of fields.
 *
 * Handles the parts a `split(',')` gets wrong: quoted fields containing the
 * delimiter, `""` escapes, embedded newlines inside quotes, and CRLF line
 * endings. A trailing newline does not produce a final empty row.
 */
export function parseDelimitedText(text: string, delimiter: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;
  // Did the current line produce anything at all? Distinguishes a real trailing
  // empty field from "the file just ended with a newline".
  let touched = false;

  const endRow = () => { row.push(field); rows.push(row); row = []; field = ''; touched = false; };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch !== '"') { field += ch; continue; }
      if (text[i + 1] === '"') { field += '"'; i++; }  // "" → a literal quote
      else inQuotes = false;
      continue;
    }
    // A quote only opens a quoted field at the field's start; elsewhere (a"b)
    // it is literal text, which is what spreadsheet exports mean by it.
    if (ch === '"' && field === '') { inQuotes = true; touched = true; continue; }
    if (ch === delimiter) { row.push(field); field = ''; touched = true; continue; }
    if (ch === '\r') { if (text[i + 1] === '\n') i++; endRow(); continue; }
    if (ch === '\n') { endRow(); continue; }
    field += ch;
    touched = true;
  }
  if (touched || field !== '' || row.length > 0) endRow();
  return rows;
}

/**
 * Pick the delimiter: `.tsv` is tab by definition; otherwise count candidates
 * outside quoted spans on the first few lines and take the winner. Sniffing
 * beats hard-coding `,` because European exports use `;` while still being
 * named `.csv`.
 */
export function detectDelimiter(text: string, filePath?: string): string {
  if (filePath && /\.tsv$/i.test(filePath)) return '\t';
  const sample = text.slice(0, 64 * 1024);
  const counts: Record<string, number> = { ',': 0, ';': 0, '\t': 0, '|': 0 };
  let inQuotes = false;
  let lines = 0;
  for (let i = 0; i < sample.length && lines < 5; i++) {
    const ch = sample[i];
    if (ch === '"') { inQuotes = !inQuotes; continue; }
    if (inQuotes) continue;
    if (ch === '\n') { lines++; continue; }
    if (ch in counts) counts[ch]++;
  }
  const best = Object.entries(counts).sort((a, b) => b[1] - a[1])[0];
  return best[1] > 0 ? best[0] : ',';
}


/** Cells that read as a number get right-aligned and sort numerically. */
const NUMERIC = /^-?[\d,]*\.?\d+%?$/;

/** Numeric value of a cell for sorting, or NaN when it isn't one. */
function numeric(cell: string): number {
  if (!NUMERIC.test(cell)) return NaN;
  return parseFloat(cell.replace(/,/g, ''));
}

/**
 * Order two cells for a sorted column. Exported for tests.
 *
 * Numbers compare numerically (so 9 < 10, which a string sort gets wrong),
 * everything else by locale with `numeric: true` so embedded digits (`item2` vs
 * `item10`) still read naturally. Empty cells sink to the BOTTOM in both
 * directions: they carry nothing to compare, and a block of blanks on top hides
 * the data being sorted.
 */
export function compareCells(x: string, y: string, dir: 1 | -1): number {
  if (x === '' || y === '') return x === y ? 0 : x === '' ? 1 : -1;
  const nx = numeric(x);
  const ny = numeric(y);
  if (!isNaN(nx) && !isNaN(ny)) return (nx - ny) * dir;
  return x.localeCompare(y, undefined, { numeric: true }) * dir;
}

type Sort = { col: number; dir: 'asc' | 'desc' } | null;

/** Row index (0-based, in file order) carried alongside the cells so filtering
 *  and sorting never lose which line a row came from. */
interface Row {
  index: number;
  cells: string[];
}

/**
 * A CSV/TSV file as a scannable grid: sticky header + row numbers, click-to-sort
 * columns, and a substring filter that can be scoped to one column.
 *
 * Filter and sort are VIEW state, deliberately not lifted to the hosts: every
 * host (Explorer pane, chat modal, the console's file-viewer widget) wants the
 * same behavior, and the raw-source view they each offer is the escape hatch
 * when someone needs the file as written.
 *
 * `action` renders one host button at the right end of the toolbar. It exists so
 * a host with no chrome of its own — the file-viewer html app, which otherwise
 * floats a fixed button over the header — has somewhere to put its
 * table/raw toggle.
 */
export function CsvTableView({ content, filePath, className = '', action }: {
  content: string;
  filePath?: string;
  className?: string;
  action?: { label: string; onClick: () => void };
}) {
  const { t } = useTranslation();
  const [visibleRows, setVisibleRows] = useState(ROWS_PER_CHUNK);
  const [query, setQuery] = useState('');
  /** Column index the filter is scoped to; -1 = every column. */
  const [scope, setScope] = useState(-1);
  const [sort, setSort] = useState<Sort>(null);

  const { header, body, columnCount } = useMemo(() => {
    const rows = parseDelimitedText(content, detectDelimiter(content, filePath))
      // Drop blank lines — a single empty field is what a bare newline parses to.
      .filter((r) => r.length > 1 || r[0] !== '');
    // Ragged rows are common in hand-edited exports; width is the widest row so
    // no data is silently hidden past the header's column count.
    const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
    const body: Row[] = rows.slice(1).map((cells, index) => ({ index, cells }));
    return { header: rows[0] ?? [], body, columnCount };
  }, [content, filePath]);

  // A new file in the same mounted view starts over: one chunk, no filter, no sort.
  useEffect(() => {
    setVisibleRows(ROWS_PER_CHUNK);
    setQuery('');
    setScope(-1);
    setSort(null);
  }, [content, filePath]);

  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    if (!needle) return body;
    return body.filter((row) =>
      scope >= 0
        ? (row.cells[scope] ?? '').toLowerCase().includes(needle)
        : row.cells.some((cell) => cell.toLowerCase().includes(needle))
    );
  }, [body, query, scope]);

  const sorted = useMemo(() => {
    if (!sort) return filtered;
    const dir: 1 | -1 = sort.dir === 'asc' ? 1 : -1;
    // Copy first: filtered may be `body` itself, and sorting in place would
    // permanently reorder the parsed file (breaking "no sort" and row numbers).
    return [...filtered].sort((a, b) =>
      compareCells(a.cells[sort.col] ?? '', b.cells[sort.col] ?? '', dir)
    );
  }, [filtered, sort]);

  // Filtering narrows the result set, so the chunk cap starts over with it —
  // otherwise a filter applied after "load more" keeps an arbitrary cap.
  useEffect(() => { setVisibleRows(ROWS_PER_CHUNK); }, [query, scope]);

  // asc → desc → off, so a click can always undo itself back to file order.
  const toggleSort = useCallback((col: number) => {
    setSort((prev) => {
      if (!prev || prev.col !== col) return { col, dir: 'asc' };
      return prev.dir === 'asc' ? { col, dir: 'desc' } : null;
    });
  }, []);

  if (columnCount === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <span className="text-sm text-muted-foreground">{t('csv.empty')}</span>
      </div>
    );
  }

  const shown = sorted.slice(0, visibleRows);
  const columnLabel = (i: number) => header[i] || `#${i + 1}`;

  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
      {/* Filter toolbar. The column <select> is a native control on purpose:
          this view also runs inside the console's file-viewer iframe, where a
          custom popover would have to solve positioning against a document the
          panel layout knows nothing about. */}
      <div className="flex items-center gap-2 px-2 py-1.5 border-b border-border flex-shrink-0">
        <div className="flex items-center gap-1.5 flex-1 min-w-0 px-1.5 py-0.5 rounded border border-border bg-card focus-within:border-brand transition-colors">
          <Search className="w-3.5 h-3.5 text-muted-foreground flex-shrink-0" aria-hidden />
          <input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder={t('csv.filterPlaceholder')}
            className="flex-1 min-w-0 bg-transparent text-xs text-foreground placeholder:text-muted-foreground outline-none"
          />
          {query && (
            <button
              onClick={() => setQuery('')}
              className="text-muted-foreground hover:text-foreground flex-shrink-0"
              title={t('csv.clearFilter')}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
        <select
          value={scope}
          onChange={(e) => setScope(Number(e.target.value))}
          className="text-xs bg-card text-muted-foreground border border-border rounded px-1 py-1 max-w-[10rem] flex-shrink-0"
          title={t('csv.filterColumn')}
        >
          <option value={-1}>{t('csv.allColumns')}</option>
          {Array.from({ length: columnCount }, (_, i) => (
            <option key={i} value={i}>{columnLabel(i)}</option>
          ))}
        </select>
        {action && (
          <button
            onClick={action.onClick}
            className="text-xs px-2 py-1 rounded border border-border text-muted-foreground hover:text-foreground hover:bg-hover transition-colors flex-shrink-0"
          >
            {action.label}
          </button>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        <table className="text-xs border-collapse w-max min-w-full">
          <thead className="sticky top-0 z-10">
            <tr>
              <th className="sticky left-0 z-20 bg-accent border-b border-r border-border px-2 py-1.5 text-right font-normal text-muted-foreground select-none">
                #
              </th>
              {Array.from({ length: columnCount }, (_, i) => (
                <th
                  key={i}
                  onClick={() => toggleSort(i)}
                  className="bg-accent border-b border-border px-2 py-1.5 text-left font-medium text-foreground whitespace-nowrap cursor-pointer select-none hover:bg-hover"
                  title={t('csv.sortHint')}
                >
                  <span className="inline-flex items-center gap-1">
                    {header[i] ?? ''}
                    {sort?.col === i && (
                      sort.dir === 'asc'
                        ? <ChevronUp className="w-3 h-3 text-brand" aria-hidden />
                        : <ChevronDown className="w-3 h-3 text-brand" aria-hidden />
                    )}
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row) => (
              // File-order row number, kept through filter and sort so a row
              // stays traceable back to the line it came from.
              <tr key={row.index} className="hover:bg-hover">
                <td className="sticky left-0 bg-card border-b border-r border-border px-2 py-1 text-right text-muted-foreground tabular-nums select-none">
                  {row.index + 1}
                </td>
                {Array.from({ length: columnCount }, (_, c) => {
                  const cell = row.cells[c] ?? '';
                  return (
                    <td
                      key={c}
                      // Long free-text cells stay readable via the tooltip; the
                      // column itself is capped so one prose field can't push
                      // every following column off screen.
                      title={cell.length > 60 ? cell : undefined}
                      className={`border-b border-border px-2 py-1 max-w-[28rem] truncate text-foreground ${
                        NUMERIC.test(cell) ? 'text-right tabular-nums' : ''
                      }`}
                    >
                      {cell}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
        {shown.length === 0 && (
          <div className="p-4 text-xs text-muted-foreground">{t('csv.noMatch')}</div>
        )}
      </div>

      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border text-xs text-muted-foreground flex-shrink-0">
        <span>
          {filtered.length === body.length
            ? t('csv.summary', { rows: body.length, cols: columnCount })
            : t('csv.summaryFiltered', { rows: filtered.length, total: body.length, cols: columnCount })}
        </span>
        {shown.length < sorted.length && (
          <button
            onClick={() => setVisibleRows((n) => n + ROWS_PER_CHUNK)}
            className="px-1.5 py-0.5 rounded hover:bg-hover hover:text-foreground transition-colors"
          >
            {t('csv.loadMore', { shown: shown.length, total: sorted.length })}
          </button>
        )}
      </div>
    </div>
  );
}

export default CsvTableView;
