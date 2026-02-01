import * as fs from 'fs';
import * as path from 'path';
import { CLAUDE_DIR } from '@/lib/paths';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface CommandInfo {
  name: string;
  description: string;
  source: 'builtin' | 'global' | 'project';
}

// 内置命令
const BUILTIN_COMMANDS: CommandInfo[] = [
  { name: '/qa', description: '进入需求澄清讨论模式', source: 'builtin' },
  { name: '/commit', description: '提交代码变更', source: 'builtin' },
  { name: '/review', description: '代码审查', source: 'builtin' },
  { name: '/test', description: '运行测试', source: 'builtin' },
  { name: '/fix', description: '修复问题', source: 'builtin' },
  { name: '/explain', description: '解释代码', source: 'builtin' },
  { name: '/refactor', description: '重构代码', source: 'builtin' },
];

// 从文件读取描述（第一行非空非标题行）
function getDescriptionFromFile(filePath: string): string {
  try {
    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed && !trimmed.startsWith('#')) {
        return trimmed.slice(0, 50);
      }
    }
  } catch {
    // 忽略读取错误
  }
  return '';
}

// 递归读取目录中的命令文件，支持子目录 (如 git/commit.md -> /git:commit)
function readCommandsFromDir(dir: string, source: 'global' | 'project', prefix: string = ''): CommandInfo[] {
  const commands: CommandInfo[] = [];

  if (!fs.existsSync(dir)) {
    return commands;
  }

  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });

    for (const entry of entries) {
      const entryPath = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // 递归处理子目录，命名格式: /subdir:command
        const subPrefix = prefix ? `${prefix}:${entry.name}` : entry.name;
        commands.push(...readCommandsFromDir(entryPath, source, subPrefix));
      } else if (entry.name.endsWith('.md')) {
        // 处理 .md 文件
        const baseName = entry.name.replace('.md', '');
        const name = prefix ? `/${prefix}:${baseName}` : `/${baseName}`;
        const description = getDescriptionFromFile(entryPath);

        commands.push({
          name,
          description: description || `Custom command: ${name}`,
          source,
        });
      }
    }
  } catch {
    // 忽略读取错误
  }

  return commands;
}

export async function GET(request: Request) {
  try {
    const { searchParams } = new URL(request.url);
    const cwd = searchParams.get('cwd');

    const commands: CommandInfo[] = [];

    // 1. 内置命令
    commands.push(...BUILTIN_COMMANDS);

    // 2. 用户全局命令 (~/.claude/commands/)
    const globalCommandsDir = path.join(CLAUDE_DIR, 'commands');
    commands.push(...readCommandsFromDir(globalCommandsDir, 'global'));

    // 3. 当前项目命令 ({cwd}/.claude/commands/)
    if (cwd) {
      const projectCommandsDir = path.join(cwd, '.claude', 'commands');
      commands.push(...readCommandsFromDir(projectCommandsDir, 'project'));
    }

    // 去重（按名称，优先级：project > global > builtin）
    const commandMap = new Map<string, CommandInfo>();
    for (const cmd of commands) {
      const existing = commandMap.get(cmd.name);
      if (!existing) {
        commandMap.set(cmd.name, cmd);
      } else {
        // 优先级：project > global > builtin
        const priority = { project: 3, global: 2, builtin: 1 };
        if (priority[cmd.source] > priority[existing.source]) {
          commandMap.set(cmd.name, cmd);
        }
      }
    }

    // 按名称排序
    const result = Array.from(commandMap.values()).sort((a, b) =>
      a.name.localeCompare(b.name)
    );

    return new Response(JSON.stringify(result), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Commands API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
