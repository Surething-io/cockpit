import { NextRequest, NextResponse } from 'next/server';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

export interface SearchMatch {
  lineNumber: number;
  content: string;
}

export interface SearchResult {
  path: string;
  matches: SearchMatch[];
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();
  const query = searchParams.get('q') || '';
  const caseSensitive = searchParams.get('caseSensitive') === 'true';
  const wholeWord = searchParams.get('wholeWord') === 'true';
  const regex = searchParams.get('regex') === 'true';
  const fileType = searchParams.get('fileType') || ''; // e.g., "ts", "tsx", "js"

  if (!query) {
    return NextResponse.json({ results: [], query: '' });
  }

  try {
    // 构建 grep 命令
    const grepArgs: string[] = [
      '-r',           // 递归搜索
      '-n',           // 显示行号
      '--include="*"', // 默认包含所有文件
    ];

    // 文件类型过滤
    if (fileType) {
      // 支持多个类型，用逗号分隔
      const types = fileType.split(',').map(t => t.trim()).filter(Boolean);
      // 清除默认的 --include="*"
      grepArgs.pop();
      for (const t of types) {
        grepArgs.push(`--include="*.${t}"`);
      }
    }

    // 区分大小写
    if (!caseSensitive) {
      grepArgs.push('-i');
    }

    // 完整词匹配
    if (wholeWord) {
      grepArgs.push('-w');
    }

    // 正则表达式 vs 固定字符串
    if (!regex) {
      grepArgs.push('-F'); // 固定字符串模式，不解析正则
    } else {
      grepArgs.push('-E'); // 扩展正则表达式
    }

    // 排除目录
    grepArgs.push('--exclude-dir=node_modules');
    grepArgs.push('--exclude-dir=.git');
    grepArgs.push('--exclude-dir=.next');
    grepArgs.push('--exclude-dir=dist');
    grepArgs.push('--exclude-dir=build');
    grepArgs.push('--exclude-dir=coverage');

    // 转义查询字符串中的特殊字符（用于 shell）
    const escapedQuery = query.replace(/'/g, "'\\''");

    const command = `grep ${grepArgs.join(' ')} -- '${escapedQuery}' . 2>/dev/null || true`;

    const { stdout } = await execAsync(command, {
      cwd,
      maxBuffer: 10 * 1024 * 1024, // 10MB buffer
      timeout: 30000, // 30s timeout
    });

    // 解析 grep 输出
    // 格式: ./path/to/file:lineNumber:content
    const lines = stdout.split('\n').filter(Boolean);
    const resultsMap = new Map<string, SearchMatch[]>();

    for (const line of lines) {
      // 匹配格式: ./path:number:content
      const match = line.match(/^\.\/(.+?):(\d+):(.*)$/);
      if (match) {
        const [, filePath, lineNum, content] = match;
        if (!resultsMap.has(filePath)) {
          resultsMap.set(filePath, []);
        }
        resultsMap.get(filePath)!.push({
          lineNumber: parseInt(lineNum, 10),
          content: content.slice(0, 500), // 限制内容长度
        });
      }
    }

    // 转换为数组格式
    const results: SearchResult[] = [];
    for (const [path, matches] of resultsMap) {
      results.push({ path, matches });
    }

    // 按文件路径排序
    results.sort((a, b) => a.path.localeCompare(b.path));

    // 限制结果数量
    const maxFiles = 100;
    const maxMatchesPerFile = 50;
    const limitedResults = results.slice(0, maxFiles).map(r => ({
      ...r,
      matches: r.matches.slice(0, maxMatchesPerFile),
    }));

    return NextResponse.json({
      results: limitedResults,
      query,
      totalFiles: results.length,
      totalMatches: results.reduce((sum, r) => sum + r.matches.length, 0),
      truncated: results.length > maxFiles,
    });
  } catch (error) {
    console.error('Search error:', error);
    return NextResponse.json(
      { error: 'Search failed', results: [] },
      { status: 500 }
    );
  }
}
