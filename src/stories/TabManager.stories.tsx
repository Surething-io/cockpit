import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { TabManager } from '@/components/TabManager';
import { ThemeProvider } from '@/components/ThemeProvider';
import { ToastProvider } from '@/components/Toast';

const meta = {
  title: 'Pages/TabManager',
  component: TabManager,
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
} satisfies Meta<typeof TabManager>;

export default meta;
type Story = StoryObj<typeof meta>;

// Note: This is the main application shell component that integrates:
// - Multiple chat tabs
// - File browser (swipeable)
// - Session browser
// - Settings modal

export const Default: Story = {
  args: {
    initialCwd: '/Users/demo/project',
  },
  parameters: {
    docs: {
      description: {
        story: `
TabManager 是应用的主要外壳组件，整合了多个子组件：

**集成的组件：**
- \`Chat\` - 聊天界面（支持多标签）
- \`FileBrowserModal\` - 文件浏览器（可滑动切换）
- \`SessionBrowser\` - 会话浏览器
- \`ProjectSessionsModal\` - 项目会话列表
- \`SettingsModal\` - 设置弹窗

**功能特点：**
- 多标签页管理
- 双指滑动切换聊天/文件浏览
- 标签页状态持久化
- 快捷键支持
        `,
      },
    },
  },
};

export const WithSessionId: Story = {
  args: {
    initialCwd: '/Users/demo/project',
    initialSessionId: 'abc123def456',
  },
  parameters: {
    docs: {
      description: {
        story: '指定初始 sessionId，会自动加载对应会话',
      },
    },
  },
};

export const NoCwd: Story = {
  args: {},
  parameters: {
    docs: {
      description: {
        story: '未指定 cwd 时的状态',
      },
    },
  },
};
