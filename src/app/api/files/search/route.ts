import { NextRequest, NextResponse } from 'next/server';
import { execFile } from 'child_process';
import { promisify } from 'util';
import { join } from 'path';

const execFileAsync = promisify(execFile);

// Next.js webpack 会静态替换 __dirname / require.resolve / import.meta.url
// process.cwd() 是运行时值，不会被 webpack 替换，且 Next.js 进程 cwd 就是项目根目录
const RG_PATH = join(process.cwd(), 'node_modules', '@vscode', 'ripgrep', 'bin', 'rg');

export interface SearchMatch {
  lineNumber: number;
  content: string;
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
}

// 结果限制
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
    const { stdout } = await searchWithRg(RG_PATH, cwd, query, opts);

    // 解析输出（统一格式: path:lineNumber:content）
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

    // 转换为数组并排序
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
// ripgrep 搜索
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
): Promise<{ stdout: string }> {
  const args: string[] = [
    '--no-heading',         // 每行输出完整路径
    '--line-number',        // 显示行号
    '--color', 'never',     // 无颜色
    '--max-columns', '500', // 限制行宽，跳过超长行
    '--max-count', String(MAX_MATCHES_PER_FILE), // 每个文件最多匹配数
    '--max-filesize', '1M', // 跳过大文件
  ];

  // rg 默认遵守 .gitignore、跳过二进制文件、跳过隐藏文件

  if (!opts.caseSensitive) args.push('-i');
  if (opts.wholeWord) args.push('-w');
  if (!opts.regex) args.push('-F'); // 固定字符串

  // 文件类型过滤
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
    // rg 退出码 1 = 无匹配（不是错误）
    if (err && typeof err === 'object' && 'code' in err && err.code === 1) {
      return { stdout: '' };
    }
    throw err;
  }
}

