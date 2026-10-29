'use client';

import { memo, useMemo, useState } from 'react';
import { ChevronRight, File, FileText, Folder } from 'lucide-react';
import type { DirFileLite } from '@cockpit/shared-api';

/**
 * Folder names that hold what a skill or Bot PRODUCED rather than what it is
 * made of (reports, run history, caches). Collapsed by default, so one that has
 * run a hundred times still opens on its references and scripts.
 */
const ARTIFACT_DIR = /^(history|reports?|cache|caches|logs?|outputs?|tmp|temp|dist|build|runs?)$/i;

interface TreeNode {
  name: string;
  /** Path relative to the skill directory; for folders, the folder path. */
  path: string;
  children?: TreeNode[];
  /** Folders: files anywhere below. */
  count?: number;
}

/**
 * Nest flat relative paths, ordered as a file browser does: folders before
 * files, each by name. SKILL.md is not pinned — it is where the pane opens
 * (selected by default), so it needs no special place in the order.
 */
function buildTree(files: readonly DirFileLite[]): TreeNode[] {
  const root: TreeNode = { name: '', path: '', children: [] };
  for (const { path } of files) {
    const parts = path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      const isFile = i === parts.length - 1;
      const childPath = parts.slice(0, i + 1).join('/');
      let child = node.children!.find((c) => c.name === part && !!c.children === !isFile);
      if (!child) {
        child = isFile ? { name: part, path: childPath } : { name: part, path: childPath, children: [], count: 0 };
        node.children!.push(child);
      }
      if (!isFile) child.count = (child.count ?? 0) + 1;
      node = child;
    });
  }
  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) => {
      if (!!a.children !== !!b.children) return a.children ? -1 : 1;
      return a.name.localeCompare(b.name);
    });
    nodes.forEach((n) => n.children && sort(n.children));
  };
  sort(root.children!);
  return root.children!;
}

interface DirectoryFileTreeProps {
  files: readonly DirFileLite[];
  selected: string;
  onSelect: (path: string) => void;
}

/** A directory as a collapsible tree — the left column of DirectoryPane. */
export const DirectoryFileTree = memo(function DirectoryFileTree({ files, selected, onSelect }: DirectoryFileTreeProps) {
  const tree = useMemo(() => buildTree(files), [files]);
  // Folder paths the user toggled away from their default state.
  const [toggled, setToggled] = useState<Set<string>>(() => new Set());

  const isOpen = (node: TreeNode) => {
    const byDefault = !ARTIFACT_DIR.test(node.name);
    return toggled.has(node.path) ? !byDefault : byDefault;
  };
  const toggle = (path: string) =>
    setToggled((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  const render = (nodes: TreeNode[], depth: number) =>
    nodes.map((node) => {
      const pad = { paddingLeft: 8 + depth * 12 };
      if (node.children) {
        const open = isOpen(node);
        return (
          <div key={`d:${node.path}`}>
            <div
              onClick={() => toggle(node.path)}
              style={pad}
              data-tooltip={node.path + '/'}
              className="flex items-center gap-1 pr-2 py-1 rounded cursor-pointer text-xs text-muted-foreground hover:bg-hover"
            >
              <ChevronRight className={`w-3 h-3 flex-shrink-0 transition-transform ${open ? 'rotate-90' : ''}`} />
              <Folder className="w-3.5 h-3.5 flex-shrink-0" />
              <span className="truncate">{node.name}</span>
              <span className="ml-auto text-[10px] tabular-nums text-foreground-subtle">
                {node.count}
              </span>
            </div>
            {open && render(node.children, depth + 1)}
          </div>
        );
      }
      const Icon = /\.(md|markdown|txt)$/i.test(node.name) ? FileText : File;
      return (
        <div
          key={`f:${node.path}`}
          onClick={() => onSelect(node.path)}
          style={{ paddingLeft: 8 + depth * 12 + 16 }}
          className={`flex items-center gap-1 pr-2 py-1 rounded cursor-pointer text-xs ${
            node.path === selected ? 'bg-brand/10 text-foreground' : 'text-muted-foreground hover:bg-hover hover:text-foreground'
          }`}
          // The app's tooltip, not native `title`: instant, wraps long names,
          // and the column is narrow enough that most names truncate.
          data-tooltip={node.path}
        >
          <Icon className="w-3.5 h-3.5 flex-shrink-0" />
          <span className="truncate font-mono">{node.name}</span>
        </div>
      );
    });

  return <div className="p-1 space-y-px">{render(tree, 0)}</div>;
});
