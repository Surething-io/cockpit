import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { GitFileTree, buildGitFileTree, type GitFileNode, type GitFileStatus } from '@/components/project/GitFileTree';
import { ToastProvider } from '@/components/shared/Toast';

const meta: Meta<typeof GitFileTree> = {
  title: 'Components/GitFileTree',
  component: GitFileTree,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <div className="h-[400px] w-[350px] border border-border rounded-lg overflow-hidden bg-card">
          <Story />
        </div>
      </ToastProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof GitFileTree>;

// Mock git file changes
interface MockFileChange {
  path: string;
  status: GitFileStatus;
  oldPath?: string;
  additions: number;
  deletions: number;
}

const modifiedFiles: MockFileChange[] = [
  { path: 'src/components/Button.tsx', status: 'modified', additions: 15, deletions: 3 },
  { path: 'src/components/Input.tsx', status: 'modified', additions: 8, deletions: 2 },
  { path: 'src/utils/api.ts', status: 'modified', additions: 25, deletions: 10 },
];

const mixedFiles: MockFileChange[] = [
  { path: 'src/components/NewComponent.tsx', status: 'added', additions: 50, deletions: 0 },
  { path: 'src/components/Button.tsx', status: 'modified', additions: 15, deletions: 3 },
  { path: 'src/components/OldComponent.tsx', status: 'deleted', additions: 0, deletions: 35 },
  { path: 'src/utils/helpers.ts', status: 'renamed', oldPath: 'src/utils/utils.ts', additions: 5, deletions: 5 },
  { path: 'src/hooks/useAuth.ts', status: 'modified', additions: 20, deletions: 8 },
  { path: 'README.md', status: 'modified', additions: 10, deletions: 2 },
];

const untrackedFiles: MockFileChange[] = [
  { path: 'src/components/Draft.tsx', status: 'untracked', additions: 30, deletions: 0 },
  { path: 'src/utils/temp.ts', status: 'untracked', additions: 15, deletions: 0 },
  { path: '.env.local', status: 'untracked', additions: 5, deletions: 0 },
];

// Interactive demo component
function GitFileTreeDemo({
  files,
  showChanges = false,
}: {
  files: MockFileChange[];
  showChanges?: boolean;
}) {
  const tree = buildGitFileTree(files);
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const [expandedPaths, setExpandedPaths] = useState<Set<string>>(() => {
    // Auto-expand all directories
    const paths = new Set<string>();
    const collectDirs = (nodes: GitFileNode<unknown>[]) => {
      for (const node of nodes) {
        if (node.isDirectory) {
          paths.add(node.path);
          collectDirs(node.children);
        }
      }
    };
    collectDirs(tree);
    return paths;
  });

  const handleSelect = (node: GitFileNode<unknown>) => {
    setSelectedPath(node.path);
  };

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
      <div className="flex-shrink-0 px-3 py-2 border-b border-border text-xs text-muted-foreground">
        {files.length} 个文件变更
      </div>
      <div className="flex-1 overflow-hidden">
        <GitFileTree
          files={tree}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onSelect={handleSelect}
          onToggle={handleToggle}
          cwd="/Users/demo/project"
          showChanges={showChanges}
        />
      </div>
      {selectedPath && (
        <div className="flex-shrink-0 p-2 border-t border-border text-xs text-muted-foreground truncate">
          选中: {selectedPath}
        </div>
      )}
    </div>
  );
}

export const Modified: Story = {
  render: () => <GitFileTreeDemo files={modifiedFiles} />,
};

export const MixedChanges: Story = {
  render: () => <GitFileTreeDemo files={mixedFiles} />,
};

export const WithChangeCounts: Story = {
  render: () => <GitFileTreeDemo files={mixedFiles} showChanges />,
  parameters: {
    docs: {
      description: {
        story: '显示每个文件的增删行数',
      },
    },
  },
};

export const UntrackedFiles: Story = {
  render: () => <GitFileTreeDemo files={untrackedFiles} showChanges />,
};

export const Empty: Story = {
  render: () => {
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set());

    return (
      <GitFileTree
        files={[]}
        selectedPath={selectedPath}
        expandedPaths={expandedPaths}
        onSelect={(node) => setSelectedPath(node.path)}
        onToggle={(path) => {
          setExpandedPaths(prev => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
          });
        }}
        cwd="/Users/demo/project"
        emptyMessage="没有文件变更"
      />
    );
  },
};

export const WithActions: Story = {
  render: () => {
    const files = modifiedFiles;
    const tree = buildGitFileTree(files);
    const [selectedPath, setSelectedPath] = useState<string | null>(null);
    const [expandedPaths, setExpandedPaths] = useState<Set<string>>(new Set(['src', 'src/components', 'src/utils']));

    return (
      <div className="h-full">
        <GitFileTree
          files={tree}
          selectedPath={selectedPath}
          expandedPaths={expandedPaths}
          onSelect={(node) => setSelectedPath(node.path)}
          onToggle={(path) => {
            setExpandedPaths(prev => {
              const next = new Set(prev);
              if (next.has(path)) next.delete(path);
              else next.add(path);
              return next;
            });
          }}
          cwd="/Users/demo/project"
          showChanges
          renderActions={(node) => !node.isDirectory && (
            <button
              className="opacity-0 group-hover:opacity-100 ml-2 p-0.5 rounded hover:bg-accent text-muted-foreground"
              onClick={(e) => {
                e.stopPropagation();
                alert(`Revert ${node.path}`);
              }}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 10h10a8 8 0 018 8v2M3 10l6 6m-6-6l6-6" />
              </svg>
            </button>
          )}
        />
      </div>
    );
  },
  parameters: {
    docs: {
      description: {
        story: '悬停显示操作按钮',
      },
    },
  },
};
