import path from 'node:path';
import { ValidationError } from '@cockpit/effect-core';
import type { SymbolKind } from '../types';
import type { CodeIndex, IndexedSymbol } from './codeIndex';
import { isTestFile } from './testFiles';
import type { ExcludedIndexFile } from './indexFiles';
import { relativeQueryPath } from './queryFilters';

const KINDS: readonly SymbolKind[] = ['function', 'method', 'class', 'interface', 'type', 'enum', 'const', 'unknown'];

export interface SymbolsOptions {
  directory: string;
  kinds: ReadonlySet<SymbolKind>;
  excludeTests: boolean;
  excludes: readonly string[];
  includeSynthetic: boolean;
  format: 'full' | 'summary';
}

export interface SymbolsResponse {
  revision: number;
  /** Coverage of the source index, including sources outside the selected directory. */
  incomplete: boolean;
  /** Number of symbols after filtering; no result-count cap is applied. */
  total: number;
  symbols: IndexedSymbol[];
  /** Oversized source exclusions across this revision, before export filters. */
  excludedFiles: ExcludedIndexFile[];
}

export interface SymbolCounts {
  total: number;
  files: number;
  byKind: Partial<Record<SymbolKind, number>>;
}

export interface SymbolsSummaryResponse extends Omit<SymbolsResponse, 'symbols'>, SymbolCounts {
  /** Immediate child directories of the selected path; direct files use that path or '.'. */
  byDirectory: Array<SymbolCounts & { path: string }>;
}

/** Validate filters before the route scans/builds the project index. */
export function parseSymbolsOptions(params: URLSearchParams): SymbolsOptions {
  const directory = relativeQueryPath(params.get('path') ?? '.', 'path');
  const requested = params.getAll('kind').flatMap(value => value.split(',').map(kind => kind.trim()));
  const kinds = !requested.length ? ['function', 'method']
    : requested.length === 1 && requested[0] === 'all' ? KINDS : requested;
  if (kinds.some(kind => !KINDS.includes(kind as SymbolKind))) {
    throw new ValidationError({ field: 'kind', reason: `Expected all or a comma-separated list of: ${KINDS.join(', ')}` });
  }
  const excludeTests = params.get('excludeTests') ?? 'false';
  if (!['true', 'false', '1', '0'].includes(excludeTests)) {
    throw new ValidationError({ field: 'excludeTests', reason: 'Expected true, false, 1 or 0' });
  }
  const includeSynthetic = params.get('includeSynthetic') ?? 'false';
  if (!['true', 'false', '1', '0'].includes(includeSynthetic)) {
    throw new ValidationError({ field: 'includeSynthetic', reason: 'Expected true, false, 1 or 0' });
  }
  const format = params.get('format') ?? 'full';
  if (format !== 'full' && format !== 'summary') {
    throw new ValidationError({ field: 'format', reason: 'Expected full or summary' });
  }
  const excludes = params.getAll('exclude').map(value => {
    if (!value || value.startsWith('!')) {
      throw new ValidationError({ field: 'exclude', reason: 'Expected a non-empty positive project-relative glob' });
    }
    return relativeQueryPath(value, 'exclude');
  });
  return { directory, kinds: new Set(kinds as SymbolKind[]), excludeTests: excludeTests === 'true' || excludeTests === '1', excludes,
    includeSynthetic: includeSynthetic === 'true' || includeSynthetic === '1', format };
}

/** Project one complete revision directly; never re-read files or retain an export cache. */
export function symbolsFromIndex(index: CodeIndex, options: SymbolsOptions): SymbolsResponse | SymbolsSummaryResponse {
  const symbols: IndexedSymbol[] = [];
  const counts: SymbolCounts = { total: 0, files: 0, byKind: {} };
  const groups = new Map<string, SymbolCounts & { path: string }>();
  for (const filePath of [...index.files.keys()].sort()) {
    if (options.directory && !filePath.startsWith(`${options.directory}/`)) continue;
    if (options.excludeTests && isTestFile(filePath)) continue;
    if (options.excludes.some(pattern => path.posix.matchesGlob(filePath, pattern))) continue;
    let group: (SymbolCounts & { path: string }) | undefined;
    for (const symbol of index.files.get(filePath)!.flatSymbols) {
      if (!options.kinds.has(symbol.kind)) continue;
      // Unknown nodes cover imports and otherwise unclaimed source lines for the UI.
      if (!options.includeSynthetic && symbol.kind === 'unknown') continue;
      if (options.format === 'full') {
        symbols.push({ ...symbol, ...(symbol.params ? { params: [...symbol.params] } : {}) });
        continue;
      }
      if (!group) {
        const relative = options.directory ? filePath.slice(options.directory.length + 1) : filePath;
        const slash = relative.indexOf('/');
        const directory = slash < 0 ? options.directory || '.'
          : [options.directory, relative.slice(0, slash)].filter(Boolean).join('/');
        group = groups.get(directory);
        if (!group) {
          group = { path: directory, total: 0, files: 0, byKind: {} };
          groups.set(directory, group);
        }
        counts.files++;
        group.files++;
      }
      for (const target of [counts, group]) {
        target.total++;
        target.byKind[symbol.kind] = (target.byKind[symbol.kind] ?? 0) + 1;
      }
    }
  }
  const metadata = {
    revision: index.revision ?? 0, incomplete: index.truncated,
    excludedFiles: (index.excludedFiles ?? []).map(file => ({ ...file })),
  };
  if (options.format === 'summary') return { ...metadata, ...counts,
    byDirectory: [...groups.values()].sort((a, b) => b.total - a.total || a.path.localeCompare(b.path)) };
  return { ...metadata, total: symbols.length, symbols };
}
