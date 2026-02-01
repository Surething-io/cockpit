import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { SessionBrowser } from '@/components/SessionBrowser';

const meta = {
  title: 'Components/SessionBrowser',
  component: SessionBrowser,
  parameters: {
    layout: 'fullscreen',
  },
} satisfies Meta<typeof SessionBrowser>;

export default meta;
type Story = StoryObj<typeof meta>;

// Note: This component requires API calls to fetch session data.
// In Storybook, you would need to set up MSW (Mock Service Worker) to mock these endpoints:
// - GET /api/sessions/projects - 获取项目列表
// - GET /api/sessions/projects/:encodedPath - 获取项目的 session 列表

export const Default: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: `
Session 浏览器组件，用于浏览历史会话记录。

此组件需要 API 调用来获取数据。在 Storybook 中需要配置 MSW 来 mock 以下端点：
- \`GET /api/sessions/projects\` - 获取项目列表
- \`GET /api/sessions/projects/:encodedPath\` - 获取项目的 session 列表

**功能特点:**
- 按项目分组显示 session
- 支持展开/折叠项目
- 支持搜索过滤
- ESC 键关闭
        `,
      },
    },
  },
};

export const Closed: Story = {
  args: {
    isOpen: false,
    onClose: () => console.log('Close clicked'),
  },
  parameters: {
    docs: {
      description: {
        story: 'isOpen=false 时不渲染任何内容',
      },
    },
  },
};
