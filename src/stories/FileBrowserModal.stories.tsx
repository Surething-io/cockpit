import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { FileBrowserModal } from '@/components/FileBrowserModal';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/Toast';

const meta = {
  title: 'Pages/FileBrowserModal',
  component: FileBrowserModal,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <ToastProvider>
          <div className="h-screen bg-background">
            <Story />
          </div>
        </ToastProvider>
      </ThemeProvider>
    ),
  ],
} satisfies Meta<typeof FileBrowserModal>;

export default meta;
type Story = StoryObj<typeof meta>;

// Note: This component requires multiple API calls:
// - GET /api/files?cwd=... - List files
// - GET /api/file-content?cwd=...&path=... - Get file content
// - GET /api/git/status?cwd=... - Get git status
// - GET /api/git/history?cwd=... - Get git history
// - GET /api/git/diff?cwd=... - Get file diff
// - GET /api/git/blame?cwd=... - Get git blame

export const TreeTab: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    cwd: '/Users/demo/project',
    initialTab: 'tree',
  },
  parameters: {
    docs: {
      description: {
        story: `
文件浏览器 - 目录树标签页

显示项目的完整文件树结构，支持：
- 展开/折叠目录
- 点击文件查看内容
- 语法高亮
- 搜索功能 (Cmd+F)
- Git Blame 视图
        `,
      },
    },
  },
};

export const RecentTab: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    cwd: '/Users/demo/project',
    initialTab: 'recent',
  },
  parameters: {
    docs: {
      description: {
        story: '最近浏览的文件列表',
      },
    },
  },
};

export const StatusTab: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    cwd: '/Users/demo/project',
    initialTab: 'status',
  },
  parameters: {
    docs: {
      description: {
        story: `
Git 变更标签页

显示工作区的 Git 状态：
- 已暂存的文件
- 未暂存的变更
- 点击文件查看 diff
        `,
      },
    },
  },
};

export const HistoryTab: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    cwd: '/Users/demo/project',
    initialTab: 'history',
  },
  parameters: {
    docs: {
      description: {
        story: `
Git 历史标签页

显示提交历史：
- 分支选择
- 提交列表（虚拟滚动）
- 点击提交查看详情和文件变更
        `,
      },
    },
  },
};

export const Closed: Story = {
  args: {
    isOpen: false,
    onClose: () => console.log('Close clicked'),
    cwd: '/Users/demo/project',
  },
  parameters: {
    docs: {
      description: {
        story: 'isOpen=false 时不渲染任何内容',
      },
    },
  },
};

// Interactive demo
function InteractiveDemo() {
  const [isOpen, setIsOpen] = useState(true);
  const [tab, setTab] = useState<'tree' | 'recent' | 'status' | 'history'>('tree');

  return (
    <>
      <div className="p-4 space-y-4">
        <div className="flex gap-2">
          {(['tree', 'recent', 'status', 'history'] as const).map((t) => (
            <button
              key={t}
              onClick={() => {
                setTab(t);
                setIsOpen(true);
              }}
              className={`px-3 py-1 rounded text-sm ${
                tab === t ? 'bg-brand text-white' : 'bg-accent'
              }`}
            >
              {t === 'tree' ? '目录树' : t === 'recent' ? '最近浏览' : t === 'status' ? 'Git 变更' : 'Git 历史'}
            </button>
          ))}
        </div>
        <p className="text-sm text-muted-foreground">
          点击按钮打开对应标签页
        </p>
      </div>
      <FileBrowserModal
        isOpen={isOpen}
        onClose={() => setIsOpen(false)}
        cwd="/Users/demo/project"
        initialTab={tab}
      />
    </>
  );
}

export const Interactive: Story = {
  render: () => <InteractiveDemo />,
};
