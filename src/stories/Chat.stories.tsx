import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Chat } from '@/components/Chat';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/Toast';

const meta = {
  title: 'Pages/Chat',
  component: Chat,
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
} satisfies Meta<typeof Chat>;

export default meta;
type Story = StoryObj<typeof meta>;

// Note: This component requires multiple API calls:
// - POST /api/session-by-path - Load session history
// - POST /api/chat - Send messages
// - Various other endpoints for session management

export const Default: Story = {
  args: {
    initialCwd: '/Users/demo/project',
  },
  parameters: {
    docs: {
      description: {
        story: `
Chat 是主要的聊天界面组件。

**依赖的 API 端点：**
- \`POST /api/session-by-path\` - 加载会话历史
- \`POST /api/chat\` - 发送消息并流式接收响应
- \`GET /api/project-state\` - 获取项目状态

**功能特点：**
- 消息列表显示（支持分页加载历史）
- 流式响应展示
- 工具调用展示
- 图片粘贴发送
- Token 使用统计
        `,
      },
    },
  },
};

export const WithSessionId: Story = {
  args: {
    initialCwd: '/Users/demo/project',
    initialSessionId: 'abc123',
  },
  parameters: {
    docs: {
      description: {
        story: '指定初始 sessionId 加载历史会话',
      },
    },
  },
};

export const HideHeader: Story = {
  args: {
    initialCwd: '/Users/demo/project',
    hideHeader: true,
  },
  parameters: {
    docs: {
      description: {
        story: '隐藏顶部标题栏',
      },
    },
  },
};

export const HideSidebar: Story = {
  args: {
    initialCwd: '/Users/demo/project',
    hideSidebar: true,
  },
  parameters: {
    docs: {
      description: {
        story: '隐藏侧边栏',
      },
    },
  },
};

export const Minimal: Story = {
  args: {
    initialCwd: '/Users/demo/project',
    hideHeader: true,
    hideSidebar: true,
  },
  parameters: {
    docs: {
      description: {
        story: '最小化模式：隐藏头部和侧边栏',
      },
    },
  },
};

export const WithCallbacks: Story = {
  args: {
    initialCwd: '/Users/demo/project',
    onLoadingChange: (isLoading) => console.log('Loading:', isLoading),
    onSessionIdChange: (sessionId) => console.log('Session ID:', sessionId),
    onTitleChange: (title) => console.log('Title:', title),
    onShowGitStatus: () => console.log('Show Git Status clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: '带回调函数，可在控制台查看回调触发',
      },
    },
  },
};
