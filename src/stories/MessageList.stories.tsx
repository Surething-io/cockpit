import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { MessageList } from '@/components/project/MessageList';

const meta = {
  title: 'Components/MessageList',
  component: MessageList,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div style={{ height: '500px' }}>
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MessageList>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Empty: Story = {
  args: {
    messages: [],
  },
};

export const WithMessages: Story = {
  args: {
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: '你好，帮我看一下项目结构',
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: '好的，让我来查看项目结构。',
        toolCalls: [
          {
            id: 'tool-1',
            name: 'Bash',
            input: { command: 'ls -la' },
            result: 'node_modules/\nsrc/\npackage.json\ntsconfig.json',
            isLoading: false,
          },
        ],
      },
      {
        id: 'msg-3',
        role: 'user',
        content: '看一下 package.json',
      },
      {
        id: 'msg-4',
        role: 'assistant',
        content: '好的，这是 package.json 的内容：',
        toolCalls: [
          {
            id: 'tool-2',
            name: 'Read',
            input: { file_path: '/package.json' },
            result: '{\n  "name": "cockpit",\n  "version": "1.0.0",\n  "dependencies": {\n    "next": "^14.0.0"\n  }\n}',
            isLoading: false,
          },
        ],
      },
    ],
  },
};

export const StreamingResponse: Story = {
  args: {
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: '解释一下这段代码',
      },
      {
        id: 'msg-2',
        role: 'assistant',
        content: '这段代码是一个 React 组件，它使用了',
        isStreaming: true,
      },
    ],
  },
};

export const Loading: Story = {
  args: {
    messages: [
      {
        id: 'msg-1',
        role: 'user',
        content: '帮我读取文件',
      },
    ],
    isLoading: true,
  },
};
