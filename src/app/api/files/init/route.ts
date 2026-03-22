import { NextRequest, NextResponse } from 'next/server';
import { stat, readdir, readlink } from 'fs/promises';
import { join } from 'path';
import { getExpandedPathsPath, readJsonFile } from '@/lib/paths';

interface FileNode {
  name: string;
  path: string;
  isDirectory: boolean;
  children?: FileNode[];
  isSymlink?: boolean;
  symlinkTarget?: string;
}

/**
 * readdir 单层目录，返回 FileNode[]（子目录默认 children: undefined）
 * 跳过 .git，检测 symlink，排序（目录优先 + 字母序）
 */
async function readdirWithMeta(cwd: string, relativePath: string): Promise<FileNode[]> {
  const absPath = relativePath ? join(cwd, relativePath) : cwd;
  let entries;
  try {
    entries = await readdir(absPath, { withFileTypes: true });
  } catch {
    return []; // 目录不存在或无权限
  }

  const nodes: FileNode[] = [];

  for (const entry of entries) {
    if (entry.name === '.git') continue;

    const entryRelPath = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    const isSymlink = entry.isSymbolicLink();
    let isDir = entry.isDirectory();

    if (isSymlink) {
      try {
        const targetStats = await stat(join(absPath, entry.name));
        isDir = targetStats.isDirectory();
      } catch {
        // broken symlink — treat as file
      }
    }

    const node: FileNode = {
      name: entry.name,
      path: entryRelPath,
      isDirectory: isDir,
      ...(isSymlink ? { isSymlink: true } : {}),
    };

    nodes.push(node);
  }

  nodes.sort((a, b) => {
    if (a.isDirectory && !b.isDirectory) return -1;
    if (!a.isDirectory && b.isDirectory) return 1;
    return a.name.localeCompare(b.name);
  });

  return nodes;
}

/**
 * 解析 symlink target（批量并行）
 */
async function resolveSymlinkTargets(nodes: FileNode[], cwd: string): Promise<void> {
  const promises: Promise<void>[] = [];
  for (const node of nodes) {
    if (node.isSymlink) {
      promises.push(
        readlink(join(cwd, node.path))
          .then(target => { node.symlinkTarget = target; })
          .catch(() => {})
      );
    }
    if (node.children) resolveSymlinkTargets(node.children, cwd);
  }
  await Promise.all(promises);
}

/**
 * 根据 expandedPaths 构建局部树：
 * - 根目录 + 各展开目录做 readdir
 * - 未展开目录 children: undefined（懒加载占位）
 */
async function buildPartialTree(cwd: string, expandedPaths: string[]): Promise<FileNode[]> {
  const expandedSet = new Set(expandedPaths);

  // 过滤出有效的展开路径：父链也必须在展开集中（否则不可见）
  const validExpanded = expandedPaths.filter(p => {
    const parts = p.split('/');
    for (let i = 1; i < parts.length; i++) {
      if (!expandedSet.has(parts.slice(0, i).join('/'))) return false;
    }
    return true;
  });

  // 并行 readdir 根目录 + 所有展开目录
  const dirsToLoad = ['', ...validExpanded];
  const results = await Promise.all(
    dirsToLoad.map(p => readdirWithMeta(cwd, p).then(nodes => ({ path: p, nodes })))
  );

  // 建立 path → children 映射
  const childrenMap = new Map<string, FileNode[]>();
  for (const { path, nodes } of results) {
    childrenMap.set(path, nodes);
  }

  // 递归组装树：给展开目录填充 children
  const assignChildren = (nodes: FileNode[]) => {
    for (const node of nodes) {
      if (node.isDirectory && childrenMap.has(node.path)) {
        node.children = childrenMap.get(node.path)!;
        assignChildren(node.children);
      }
      // 未展开目录：children 保持 undefined
    }
  };

  const root = childrenMap.get('') || [];
  assignChildren(root);

  return root;
}

/**
 * GET /api/files/init?cwd=...
 * 返回 { files, expandedPaths, cwd }
 */
export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const cwd = searchParams.get('cwd') || process.cwd();

  try {
    // 验证 cwd 存在且是目录
    const stats = await stat(cwd);
    if (!stats.isDirectory()) {
      return NextResponse.json({ error: 'Path is not a directory' }, { status: 400 });
    }

    // 读取持久化的展开路径
    const expandedPathsFile = getExpandedPathsPath(cwd);
    const expandedPaths = await readJsonFile<string[]>(expandedPathsFile, []);

    // 构建局部树
    const files = await buildPartialTree(cwd, expandedPaths);

    // 解析 symlink targets
    await resolveSymlinkTargets(files, cwd);

    return NextResponse.json({ files, expandedPaths, cwd });
  } catch (error) {
    console.error('Error initializing file tree:', error);
    return NextResponse.json({ error: 'Failed to initialize file tree' }, { status: 500 });
  }
}
