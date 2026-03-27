import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);

// Next.js webpack statically replaces __dirname / require.resolve / import.meta.url
// process.cwd() is a runtime value, not replaced by webpack; Next.js process cwd is the project root
const RG_PATH = join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');

export interface SearchMatch {
  lineNumber: number;
  content: string;
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
}

// Result limits
const MAX_FILES = 100;
const MAX_MATCHES_PER_FILE = 50;
const MAX_TOTAL_LINES = 5000;

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const query = searchParams.get('q') || '';
  const caseSensitive = searchParams.get('caseSensitive') === 'true';
  const wholeWord = searchParams.get('wholeWord') === 'true';
  const regex = searchParams.get('regex') === 'true';
  const fileType = searchParams.get('fileType') || '';

  if (!query) {
    return NextResponse.json({ results: [], query: '' });
  }

  try {
    const opts: SearchOptions = { caseSensitive, wholeWord, regex, fileType };

    const { stdout } = await searchWithRg(RG_PATH, cwd, query, opts, []);

    // Parse output (format: path:lineNumber:content)
    const lines = stdout.split('\n').filter(Boolean);
    const resultsMap = new Map<string, SearchMatch[]>();
    let totalLines = 0;

    for (const line of lines) {
      if (totalLines >= MAX_TOTAL_LINES) break;

      const match = line.match(/^(?:\.\/)?(.+?):(\d+):(.*)$/);
      if (match) {
        const [, filePath, lineNum, content] = match;
        if (!resultsMap.has(filePath)) {
          if (resultsMap.size >= MAX_FILES) continue;
          resultsMap.set(filePath, []);
        }
        const matches = resultsMap.get(filePath)!;
        if (matches.length >= MAX_MATCHES_PER_FILE) continue;
        matches.push({
          lineNumber: parseInt(lineNum, 10),
          content: content.slice(0, 500),
        });
        totalLines++;
      }
    }

    // Convert to array and sort
    const results: SearchResult[] = [];
    for (const [path, matches] of resultsMap) {
      results.push({ path, matches });
    }
    results.sort((a, b) => a.path.localeCompare(b.path));

    return NextResponse.json({
      results,
      query,
      totalFiles: results.length,
      totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
      truncated: totalLines >= MAX_TOTAL_LINES || resultsMap.size >= MAX_FILES,
    });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: 'Search failed', results: [] },
      { status: 500 }
    );
  }
}

// ============================================
// ripgrep search
// ============================================

interface SearchOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
  fileType: string;
}

async function searchWithRg(
  rgBin: string,
  cwd: string,
  query: string,
  opts: SearchOptions,
  extraArgs: string[],
): Promise<{ stdout: string }> {
  const args: string[] = [
    '--no-heading',         // Print full path on every line
    '--line-number',        // Show line numbers
    '--color', 'never',     // No color
    '--max-columns', '500', // Limit line width, skip very long lines
    '--max-count', String(MAX_MATCHES_PER_FILE), // Max matches per file
    '--max-filesize', '1M', // Skip large files
    '--hidden',             // Include hidden files (.env.local, etc.)
    '--follow',             // Follow symlinks
    '--glob', '!.git',      // Exclude .git directory
    ...extraArgs,
  ];

  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  if (!opts.regex) args.push('-F'); // Fixed string

  // File type filter
  if (opts.fileType) {
    const types = opts.fileType.split(',').map(t => t.trim()).filter(Boolean);
    for (const t of types) {
      args.push('-g', `*.${t}`);
    }
  }

  args.push('--', query, '.');

  try {
    return await execFileAsync(rgBin, args, {
      cwd,
      maxBuffer: 5 * 1024 * 1024,
      timeout: 10000,
    });
  } catch (err: unknown) {
    if (err && typeof err === 'object' && 'code' in err) {
      // exit 1 = no matches found
      if (err.code === 1) return { stdout: '' };
      // exit 2 = errors (e.g. broken symlink) but may still have partial results
      if (err.code === 2 && 'stdout' in err && typeof err.stdout === 'string' && err.stdout) {
        return { stdout: err.stdout };
      }
    }
    throw err;
  }
}
