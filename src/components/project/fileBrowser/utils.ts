import type { FileNode } from './types';

/**
 * 递归查找文件节点
 */
export function findNodeByPath(nodes: FileNode[], path: string): FileNode | null {
  for (const node of nodes) {
    if (node.path === path) return node;
    if (node.children) {
      const found = findNodeByPath(node.children, path);
      if (found) return found;
    }
  }
  return null;
}

/**
 * 获取目标目录路径（用于新建文件/文件夹）
 * 如果选中的是目录，返回该目录路径
 * 如果选中的是文件，返回其父目录路径
 * 如果没有选中，返回空字符串（根目录）
 */
export function getTargetDirPath(selectedPath: string | null, files: FileNode[]): string {
  if (!selectedPath) return '';
  const node = findNodeByPath(files, selectedPath);
  if (node?.isDirectory) return selectedPath;
  // 文件的父目录
  const parts = selectedPath.split('/');
  parts.pop();
  return parts.join('/');
}

export function buildTreeFromPaths(filePaths: string[]): FileNode[] {
  const root: FileNode[] = [];

  for (const filePath of filePaths) {
    const parts = filePath.split('/');
    let currentLevel = root;

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i];
      const isLast = i === parts.length - 1;
      const currentPath = parts.slice(0, i + 1).join('/');

      let existing = currentLevel.find(n => n.name === part);

      if (!existing) {
        existing = {
          name: part,
          path: currentPath,
          isDirectory: !isLast,
          children: isLast ? undefined : [],
        };
        currentLevel.push(existing);
      }

      if (!isLast && existing.children) {
        currentLevel = existing.children;
      }
    }
  }

  const sortNodes = (nodes: FileNode[]) => {
    nodes.sort((a, b) => {
      if (a.isDirectory && !b.isDirectory) return -1;
      if (!a.isDirectory && b.isDirectory) return 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach(n => {
      if (n.children) sortNodes(n.children);
    });
  };

  sortNodes(root);
  return root;
}

export function collectAllDirPaths(nodes: FileNode[]): string[] {
  const paths: string[] = [];
  const traverse = (nodeList: FileNode[]) => {
    for (const node of nodeList) {
      if (node.isDirectory) {
        paths.push(node.path);
        if (node.children) traverse(node.children);
      }
    }
  };
  traverse(nodes);
  return paths;
}

const IMAGE_EXTENSIONS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'ico', 'bmp']);

export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase();
  return IMAGE_EXTENSIONS.has(ext || '');
}

export function computeMatchedPaths(nodes: FileNode[], searchQuery: string, exactMatch: boolean = false): Set<string> {
  const matched = new Set<string>();
  if (!searchQuery) return matched;

  const query = searchQuery.toLowerCase();

  // 将节点及其所有子孙全部加入 matched
  const addAllDescendants = (node: FileNode) => {
    matched.add(node.path);
    if (node.children) {
      for (const child of node.children) {
        addAllDescendants(child);
      }
    }
  };

  const traverse = (node: FileNode, ancestors: string[]): boolean => {
    const nameLower = node.name.toLowerCase();
    const nameMatches = exactMatch ? nameLower === query : nameLower.includes(query);

    // 目录名命中：该目录下所有子孙全部显示
    if (nameMatches && node.children) {
      addAllDescendants(node);
      ancestors.forEach(p => matched.add(p));
      return true;
    }

    let childMatches = false;

    if (node.children) {
      for (const child of node.children) {
        if (traverse(child, [...ancestors, node.path])) {
          childMatches = true;
        }
      }
    }

    if (nameMatches || childMatches) {
      matched.add(node.path);
      ancestors.forEach(p => matched.add(p));
      return true;
    }
    return false;
  };

  for (const node of nodes) {
    traverse(node, []);
  }

  return matched;
}

export function formatRelativeTime(timestamp: number): string {
  const now = Date.now();
  const diff = now - timestamp * 1000;
  const seconds = Math.floor(diff / 1000);
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  const months = Math.floor(days / 30);
  const years = Math.floor(days / 365);

  if (years > 0) return `${years}y ago`;
  if (months > 0) return `${months}mo ago`;
  if (days > 0) return `${days}d ago`;
  if (hours > 0) return `${hours}h ago`;
  if (minutes > 0) return `${minutes}m ago`;
  return 'just now';
}

export function formatDateTime(dateStr: string): string {
  const date = new Date(dateStr);
  const now = new Date();
  const isThisYear = date.getFullYear() === now.getFullYear();

  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  const hours = String(date.getHours()).padStart(2, '0');
  const minutes = String(date.getMinutes()).padStart(2, '0');

  if (isThisYear) {
    return `${month}-${day} ${hours}:${minutes}`;
  }
  return `${date.getFullYear()}-${month}-${day} ${hours}:${minutes}`;
}

export const NOOP = () => {};
export const COMMITS_PER_PAGE = 50;
