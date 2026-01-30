import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface ProjectInfo {
  name: string;        // 最后一级目录名（用于排序）
  fullPath: string;    // 完整路径（用于显示）
  encodedPath: string; // 编码后的路径（用于查询 session）
  sessionCount: number;
}

interface SessionsIndex {
  version: number;
  entries: Array<{
    sessionId: string;
    projectPath: string;
  }>;
  originalPath?: string;
}

// 从 sessions-index.json 读取真实项目路径
function getProjectPathFromIndex(projectDir: string): string | null {
  const indexPath = path.join(projectDir, 'sessions-index.json');
  if (!fs.existsSync(indexPath)) {
    return null;
  }

  try {
    const content = fs.readFileSync(indexPath, 'utf-8');
    const index: SessionsIndex = JSON.parse(content);

    // 优先使用 originalPath
    if (index.originalPath) {
      return index.originalPath;
    }

    // 否则从第一个 entry 的 projectPath 获取
    if (index.entries && index.entries.length > 0 && index.entries[0].projectPath) {
      return index.entries[0].projectPath;
    }
  } catch {
    // 解析失败，返回 null
  }

  return null;
}

// 从 jsonl 文件中读取 cwd 字段
function getProjectPathFromJsonl(projectDir: string): string | null {
  try {
    const files = fs.readdirSync(projectDir)
      .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'));

    for (const file of files) {
      const filePath = path.join(projectDir, file);
      const content = fs.readFileSync(filePath, 'utf-8');
      const lines = content.split('\n');

      for (const line of lines) {
        if (!line.trim()) continue;
        try {
          const obj = JSON.parse(line);
          if (obj.cwd) {
            return obj.cwd;
          }
        } catch {
          // 忽略解析错误
        }
      }
    }
  } catch {
    // 忽略读取错误
  }

  return null;
}

// 回退方案：简单替换 - 为 /
function fallbackDecodeProjectPath(encodedPath: string): string {
  return '/' + encodedPath.slice(1).replace(/-/g, '/');
}

export async function GET() {
  try {
    const homeDir = os.homedir();
    const projectsDir = path.join(homeDir, '.claude', 'projects');

    // 检查目录是否存在
    if (!fs.existsSync(projectsDir)) {
      return new Response(JSON.stringify([]), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // 读取所有项目目录
    const projectDirs = fs.readdirSync(projectsDir, { withFileTypes: true })
      .filter(dirent => dirent.isDirectory())
      .map(dirent => dirent.name);

    const projects: ProjectInfo[] = [];

    for (const projectDirName of projectDirs) {
      const projectPath = path.join(projectsDir, projectDirName);

      // 优先从 sessions-index.json 获取真实路径，其次从 jsonl 文件读取 cwd
      const fullPath = getProjectPathFromIndex(projectPath)
        || getProjectPathFromJsonl(projectPath)
        || fallbackDecodeProjectPath(projectDirName);

      // 获取最后一级目录名
      const projectName = path.basename(fullPath);

      // 统计 session 数量（排除 agent-* 开头的子进程文件）
      const sessionCount = fs.readdirSync(projectPath)
        .filter(file => file.endsWith('.jsonl') && !file.startsWith('agent-'))
        .length;

      if (sessionCount > 0) {
        projects.push({
          name: projectName,
          fullPath,
          encodedPath: projectDirName,
          sessionCount,
        });
      }
    }

    // 按最后一级目录名字母排序
    projects.sort((a, b) => a.name.localeCompare(b.name));

    return new Response(JSON.stringify(projects), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  } catch (error) {
    console.error('Projects API error:', error);
    return new Response(JSON.stringify({ error: 'Internal server error' }), {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
    });
  }
}
