import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { FileTree, type FileNode } from '@/components/project/FileTree';
import { ToastProvider } from '@/components/shared/Toast';

const meta: Meta<typeof FileTree> = {
  title: 'Components/FileTree',
  component: FileTree,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div className="h-[400px] w-[300px] border border-border rounded-lg overflow-hidden bg-card">
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof FileTree>;

// Mock file tree data
const simpleTree: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    isDirectory: true,
    children: [
      { name: 'index.ts', path: 'src/index.ts', isDirectory: false },
      { name: 'utils.ts', path: 'src/utils.ts', isDirectory: false },
      { name: 'types.ts', path: 'src/types.ts', isDirectory: false },
    ],
  },
  { name: 'package.json', path: 'package.json', isDirectory: false },
  { name: 'tsconfig.json', path: 'tsconfig.json', isDirectory: false },
  { name: 'README.md', path: 'README.md', isDirectory: false },
];

const deepTree: FileNode[] = [
  {
    name: 'src',
    path: 'src',
    isDirectory: true,
    children: [
      {
        name: 'components',
        path: 'src/components',
        isDirectory: true,
        children: [
          {
            name: 'ui',
            path: 'src/components/ui',
            isDirectory: true,
            children: [
              { name: 'Button.tsx', path: 'src/components/ui/Button.tsx', isDirectory: false },
              { name: 'Input.tsx', path: 'src/components/ui/Input.tsx', isDirectory: false },
              { name: 'Modal.tsx', path: 'src/components/ui/Modal.tsx', isDirectory: false },
            ],
          },
          {
            name: 'layout',
            path: 'src/components/layout',
            isDirectory: true,
            children: [
              { name: 'Header.tsx', path: 'src/components/layout/Header.tsx', isDirectory: false },
              { name: 'Footer.tsx', path: 'src/components/layout/Footer.tsx', isDirectory: false },
              { name: 'Sidebar.tsx', path: 'src/components/layout/Sidebar.tsx', isDirectory: false },
            ],
          },
          { name: 'index.ts', path: 'src/components/index.ts', isDirectory: false },
        ],
      },
      {
        name: 'hooks',
        path: 'src/hooks',
        isDirectory: true,
        children: [
          { name: 'useAuth.ts', path: 'src/hooks/useAuth.ts', isDirectory: false },
          { name: 'useTheme.ts', path: 'src/hooks/useTheme.ts', isDirectory: false },
        ],
      },
      {
        name: 'utils',
        path: 'src/utils',
        isDirectory: true,
        children: [
          { name: 'api.ts', path: 'src/utils/api.ts', isDirectory: false },
          { name: 'helpers.ts', path: 'src/utils/helpers.ts', isDirectory: false },
        ],
      },
      { name: 'App.tsx', path: 'src/App.tsx', isDirectory: false },
      { name: 'index.tsx', path: 'src/index.tsx', isDirectory: false },
    ],
  },
  {
    name: 'public',
    path: 'public',
    isDirectory: true,
    children: [
      { name: 'favicon.ico', path: 'public/favicon.ico', isDirectory: false },
      { name: 'logo.svg', path: 'public/logo.svg', isDirectory: false },
    ],
  },
  { name: 'package.json', path: 'package.json', isDirectory: false },
  { name: 'tsconfig.json', path: 'tsconfig.json', isDirectory: false },
];

const manyFilesTree: FileNode[] = [
  {
    name: 'components',
    path: 'components',
    isDirectory: true,
    children: Array.from({ length: 50 }, (_, i) => ({
      name: `Component${i + 1}.tsx`,
      path: `components/Component${i + 1}.tsx`,
      isDirectory: false,
    })),
  },
];

// Interactive demo
function FileTreeDemo({ tree, searchKeyword }: { tree: FileNode[]; searchKeyword?: string }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    // Auto-expand root directories
    const paths = new Set<string>();
    for (const node of tree) {
      if (node.isDirectory) {
        paths.add(node.path);
      }
    }
    return paths;
  });

  const handleToggle = (path: string) => {
    setExpandedPaths(prev => {
      const next = new Set(prev);
      if (next.has(path)) {
        next.delete(path);
      } else {
        next.add(path);
      }
      return next;
    });
  };

  return (
    <div className="h-full flex flex-col">
      <FileTree
        files={tree}
        selectedPath={selectedPath}
        expandedPaths={expandedPaths}
        onSelect={setSelectedPath}
        onToggle={handleToggle}
        cwd="/Users/demo/project"
        matchedPaths={searchKeyword ? new Set(
          tree.flatMap(function collectPaths(node: FileNode): string[] {
            const matches: string[] = [];
            if (node.name.toLowerCase().includes(searchKeyword.toLowerCase())) {
              matches.push(node.path);
            }
            if (node.children) {
              matches.push(...node.children.flatMap(collectPaths));
            }
            return matches;
          })
        ) : null}
      />
      {selectedPath && (
        <div className="flex-shrink-0 p-2 border-t border-border text-xs text-muted-foreground">
          选中: {selectedPath}
        </div>
      )}
    </div>
  );
}

export const Simple: Story = {
  render: () => <FileTreeDemo tree={simpleTree} />,
};

export const DeepNesting: Story = {
  render: () => <FileTreeDemo tree={deepTree} />,
};

export const ManyFiles: Story = {
  render: () => <FileTreeDemo tree={manyFilesTree} />,
  parameters: {
    docs: {
      description: {
        story: '测试虚拟滚动性能，展示 50 个文件',
      },
    },
  },
};

export const WithSearch: Story = {
  render: () => {
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['src', 'src/components', 'src/components/ui']));
    const [search, setSearch] = useState('');

    // Collect matching paths
    const matchedPaths = search ? new Set(
      deepTree.flatMap(function collectPaths(node: FileNode): string[] {
        const matches: string[] = [];
        if (node.name.toLowerCase().includes(search.toLowerCase())) {
          matches.push(node.path);
        }
        if (node.children) {
          matches.push(...node.children.flatMap(collectPaths));
        }
        return matches;
      })
    ) : null;

    return (
      <div className="h-full flex flex-col">
        <div className="flex-shrink-0 p-2 border-b border-border">
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="搜索文件..."
            className="w-full px-2 py-1 text-sm border border-border rounded bg-background"
          />
        </div>
        <div className="flex-1 overflow-hidden">
          <FileTree
            files={deepTree}
            selectedPath={selectedPath}
            expandedPaths={expandedPaths}
            matchedPaths={matchedPaths}
            onSelect={setSelectedPath}
            onToggle={(path) => {
              setExpandedPaths(prev => {
                const next = new Set(prev);
                if (next.has(path)) next.delete(path);
                else next.add(path);
                return next;
              });
            }}
            cwd="/Users/demo/project"
          />
        </div>
      </div>
    );
  },
};

export const PreSelected: Story = {
  render: () => {
    const [selectedPath, setSelectedPath] = useState<string | null>('src/components/ui/Button.tsx');
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(
      new Set(['src', 'src/components', 'src/components/ui'])
    );

    return (
      <FileTree
        files={deepTree}
        selectedPath={selectedPath}
        expandedPaths={expandedPaths}
        onSelect={setSelectedPath}
        onToggle={(path) => {
          setExpandedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          });
        }}
        cwd="/Users/demo/project"
      />
    );
  },
};
