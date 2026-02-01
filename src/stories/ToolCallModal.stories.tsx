import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ToolCallModal } from '@/components/ToolCallModal';

const meta = {
  title: 'Components/ToolCallModal',
  component: ToolCallModal,
  parameters: {
    layout: 'padded',
  },
} satisfies Meta<typeof ToolCallModal>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Loading: Story = {
  args: {
    toolCall: {
      id: 'tool-1',
      name: 'Read',
      input: { file_path: '/src/app/page.tsx' },
      isLoading: true,
    },
  },
};

export const Completed: Story = {
  args: {
    toolCall: {
      id: 'tool-2',
      name: 'Read',
      input: { file_path: '/src/app/page.tsx' },
      result: 'import { Chat } from "@/components";\n\nexport default function Home() {\n  return <Chat />;\n}',
      isLoading: false,
    },
  },
};

export const BashCommand: Story = {
  args: {
    toolCall: {
      id: 'tool-3',
      name: 'Bash',
      input: { command: 'ls -la' },
      result: 'total 64\ndrwxr-xr-x  12 user  staff   384 Jan 28 10:00 .\ndrwxr-xr-x   5 user  staff   160 Jan 28 09:00 ..',
      isLoading: false,
    },
  },
};

export const EditFile: Story = {
  args: {
    toolCall: {
      id: 'tool-4',
      name: 'Edit',
      input: {
        file_path: '/src/components/Chat.tsx',
        old_string: 'const [messages, setMessages]',
        new_string: 'const [chatMessages, setChatMessages]',
      },
      result: 'File edited successfully',
      isLoading: false,
    },
  },
};
