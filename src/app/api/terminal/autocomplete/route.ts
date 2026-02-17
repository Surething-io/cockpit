import { NextRequest } from 'next/server';
import { spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface AutocompleteRequest {
  cwd: string;
  input: string;
  cursorPosition: number;
}

// 获取常见命令列表
const COMMON_COMMANDS = [
  'ls', 'cd', 'pwd', 'cat', 'echo', 'mkdir', 'rm', 'cp', 'mv', 'touch',
  'git', 'npm', 'node', 'python', 'python3', 'pip', 'cargo', 'go',
  'docker', 'kubectl', 'curl', 'wget', 'grep', 'find', 'sed', 'awk',
];

export async function POST(request: NextRequest) {
  try {
    const body: AutocompleteRequest = await request.json();
    const { cwd, input, cursorPosition } = body;

    if (!cwd || input === undefined) {
      return new Response(JSON.stringify({ error: 'Missing cwd or input' }), {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 分析输入，找到需要补全的部分
    const beforeCursor = input.substring(0, cursorPosition);
    const words = beforeCursor.split(/\s+/);
    const lastWord = words[words.length - 1] || '';

    let suggestions: string[] = [];

    // 如果是第一个词，补全命令
    if (words.length === 1 && !beforeCursor.includes(' ')) {
      suggestions = COMMON_COMMANDS.filter((cmd) => cmd.startsWith(lastWord));
    } else {
      // 否则补全路径
      suggestions = await getPathSuggestions(cwd, lastWord);
    }

    return new Response(
      JSON.stringify({
        suggestions,
        prefix: lastWord,
        replaceStart: cursorPosition - lastWord.length,
        replaceEnd: cursorPosition,
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  } catch (error) {
    console.error('Autocomplete error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}

// 获取路径补全建议
async function getPathSuggestions(cwd: string, partialPath: string): Promise<string[]> {
  try {
    // 解析路径
    const isAbsolute = partialPath.startsWith('/');
    const basePath = isAbsolute
      ? path.dirname(partialPath === '/' ? '/' : partialPath)
      : partialPath.includes('/')
      ? path.join(cwd, path.dirname(partialPath))
      : cwd;

    const prefix = path.basename(partialPath);

    // 读取目录
    const entries = await fs.readdir(basePath, { withFileTypes: true });

    // 过滤并格式化建议
    const suggestions = entries
      .filter((entry) => entry.name.startsWith(prefix) && !entry.name.startsWith('.'))
      .map((entry) => {
        const name = entry.name;
        // 如果是目录，添加斜杠
        return entry.isDirectory() ? `${name}/` : name;
      })
      .slice(0, 20); // 限制数量

    return suggestions;
  } catch (error) {
    console.error('Path suggestions error:', error);
    return [];
  }
}
