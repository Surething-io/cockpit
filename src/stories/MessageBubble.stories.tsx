import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { MessageBubble } from '@/components/MessageBubble';

const meta = {
  title: 'Components/MessageBubble',
  component: MessageBubble,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof MessageBubble>;

export default meta;
type Story = StoryObj<typeof meta>;

export const UserMessage: Story = {
  args: {
    message: {
      id: 'msg-1',
      role: 'user',
      content: '帮我读取 package.json 文件',
    },
  },
};

export const AssistantMessage: Story = {
  args: {
    message: {
      id: 'msg-2',
      role: 'assistant',
      content: '好的，我来帮你读取 package.json 文件。',
    },
  },
};

export const StreamingMessage: Story = {
  args: {
    message: {
      id: 'msg-3',
      role: 'assistant',
      content: '正在处理中',
      isStreaming: true,
    },
  },
};

export const MessageWithToolCall: Story = {
  args: {
    message: {
      id: 'msg-4',
      role: 'assistant',
      content: '让我来读取文件：',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'Read',
          input: { file_path: '/package.json' },
          result: '{\n  "name": "chat-demo",\n  "version": "1.0.0"\n}',
          isLoading: false,
        },
      ],
    },
  },
};

export const MultipleToolCalls: Story = {
  args: {
    message: {
      id: 'msg-5',
      role: 'assistant',
      content: '我来搜索并读取相关文件：',
      toolCalls: [
        {
          id: 'tool-1',
          name: 'Glob',
          input: { pattern: '**/*.tsx' },
          result: 'src/app/page.tsx\nsrc/components/Chat.tsx',
          isLoading: false,
        },
        {
          id: 'tool-2',
          name: 'Read',
          input: { file_path: '/src/app/page.tsx' },
          result: 'import { Chat } from "@/components";',
          isLoading: false,
        },
      ],
    },
  },
};
