import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { FileTree, type FileNode } from '@/components/FileTree';
import { ToastProvider } from '@/components/Toast';

const meta = {
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
} satisfies Meta<typeof FileTree>;

export default meta;
type Story = StoryObj<typeof meta>;

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
function FileTreeDemo({ tree }: { tree: FileNode[] }) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);

  return (
    <div className="h-full flex flex-col">
      <FileTree
        tree={tree}
        selectedPath={selectedPath}
        onSelectFile={setSelectedPath}
        cwd="/Users/demo/project"
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
    const [search, setSearch] = useState('');

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
            tree={deepTree}
            selectedPath={selectedPath}
            onSelectFile={setSelectedPath}
            cwd="/Users/demo/project"
            searchKeyword={search}
          />
        </div>
      </div>
    );
  },
};

export const PreSelected: Story = {
  args: {
    tree: deepTree,
    selectedPath: 'src/components/ui/Button.tsx',
    onSelectFile: () => {},
    cwd: '/Users/demo/project',
  },
};
