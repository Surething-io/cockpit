import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { CommitDetailPanel, type CommitInfo } from '@/components/project/CommitDetailPanel';

const meta = {
  title: 'Components/CommitDetailPanel',
  component: CommitDetailPanel,
  parameters: {
    layout: 'fullscreen',
    // Mock fetch for storybook
    msw: {
      handlers: [],
    },
  },
} satisfies Meta<typeof CommitDetailPanel>;

export default meta;
type Story = StoryObj<typeof meta>;

// Mock commit data
const mockCommit: CommitInfo = {
  hash: 'a1b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0',
  shortHash: 'a1b2c3d',
  author: 'John Doe',
  authorEmail: 'john@example.com',
  date: '2024-01-15T10:30:00Z',
  subject: 'feat: Add new authentication system',
  body: `This commit introduces a new authentication system with the following features:

- JWT-based token authentication
- Refresh token rotation
- Secure password hashing with bcrypt
- Rate limiting for login attempts

BREAKING CHANGE: The old session-based auth is deprecated.`,
  relativeDate: '2 days ago',
};

const simpleCommit: CommitInfo = {
  hash: 'b2c3d4e5f6g7h8i9j0k1l2m3n4o5p6q7r8s9t0u1',
  shortHash: 'b2c3d4e',
  author: 'Jane Smith',
  authorEmail: 'jane@example.com',
  date: '2024-01-14T15:45:00Z',
  subject: 'fix: Resolve button hover state issue',
  body: '',
  relativeDate: '3 days ago',
};

// Note: This component requires API calls to fetch file changes and diffs.
// In Storybook, you would need to set up MSW (Mock Service Worker) to mock these endpoints:
// - GET /api/git/commit-diff?cwd=...&hash=...
// - GET /api/git/commit-diff?cwd=...&hash=...&file=...

export const Default: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    commit: mockCommit,
    cwd: '/Users/demo/project',
  },
  parameters: {
    docs: {
      description: {
        story: `
此组件需要 API 调用来获取文件变更和 diff 内容。
在实际使用中，需要配置 MSW 来 mock 以下端点：
- \`GET /api/git/commit-diff?cwd=...&hash=...\` - 获取 commit 的文件列表
- \`GET /api/git/commit-diff?cwd=...&hash=...&file=...\` - 获取单个文件的 diff
        `,
      },
    },
  },
};

export const SimpleCommit: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    commit: simpleCommit,
    cwd: '/Users/demo/project',
  },
};

export const Embedded: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    commit: mockCommit,
    cwd: '/Users/demo/project',
    embedded: true,
  },
  decorators: [
    (Story) => (
      <div className="h-[600px] border border-border rounded-lg overflow-hidden">
        <Story />
      </div>
    ),
  ],
  parameters: {
    docs: {
      description: {
        story: '内嵌模式，无 Modal 包装，直接显示内容',
      },
    },
  },
};

export const WithInitialFile: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
    commit: mockCommit,
    cwd: '/Users/demo/project',
    initialFilePath: 'src/auth/login.ts',
  },
  parameters: {
    docs: {
      description: {
        story: '指定初始选中的文件路径',
      },
    },
  },
};

export const Closed: Story = {
  args: {
    isOpen: false,
    onClose: () => console.log('Close clicked'),
    commit: mockCommit,
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
