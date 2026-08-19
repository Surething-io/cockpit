'use client';

import { useEffect, useMemo, useState } from 'react';
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

const NUMERIC = /^-?[\d,]*\.?\d+%?$/;

export function CsvTableView({ content, filePath, className = '' }: {
  content: string;
  filePath?: string;
  className?: string;
}) {
  const { t } = useTranslation();
  const [visibleRows, setVisibleRows] = useState(ROWS_PER_CHUNK);

  const { header, body, columnCount } = useMemo(() => {
    const rows = parseDelimitedText(content, detectDelimiter(content, filePath))
      // Drop blank lines — a single empty field is what a bare newline parses to.
      .filter((r) => r.length > 1 || r[0] !== '');
    // Ragged rows are common in hand-edited exports; width is the widest row so
    // no data is silently hidden past the header's column count.
    const columnCount = rows.reduce((max, r) => Math.max(max, r.length), 0);
    return { header: rows[0] ?? [], body: rows.slice(1), columnCount };
  }, [content, filePath]);

  // A new file in the same mounted view starts over at one chunk.
  useEffect(() => { setVisibleRows(ROWS_PER_CHUNK); }, [content, filePath]);

  if (header.length === 0) {
    return (
      <div className={`flex items-center justify-center ${className}`}>
        <span className="text-sm text-muted-foreground">{t('csv.empty')}</span>
      </div>
    );
  }

  const shown = body.slice(0, visibleRows);

  return (
    <div className={`flex flex-col min-h-0 ${className}`}>
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
                  className="bg-accent border-b border-border px-2 py-1.5 text-left font-medium text-foreground whitespace-nowrap"
                >
                  {header[i] ?? ''}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {shown.map((row, r) => (
              <tr key={r} className="hover:bg-hover">
                <td className="sticky left-0 bg-card border-b border-r border-border px-2 py-1 text-right text-muted-foreground tabular-nums select-none">
                  {r + 1}
                </td>
                {Array.from({ length: columnCount }, (_, c) => {
                  const cell = row[c] ?? '';
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
      </div>
      <div className="flex items-center gap-3 px-3 py-1.5 border-t border-border text-xs text-muted-foreground flex-shrink-0">
        <span>{t('csv.summary', { rows: body.length, cols: columnCount })}</span>
        {shown.length < body.length && (
          <button
            onClick={() => setVisibleRows((n) => n + ROWS_PER_CHUNK)}
            className="px-1.5 py-0.5 rounded hover:bg-hover hover:text-foreground transition-colors"
          >
            {t('csv.loadMore', { shown: shown.length, total: body.length })}
          </button>
        )}
      </div>
    </div>
  );
}

export default CsvTableView;
