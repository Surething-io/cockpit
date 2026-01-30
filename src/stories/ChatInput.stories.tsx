import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ChatInput } from '@/components/ChatInput';

const meta = {
  title: 'Components/ChatInput',
  component: ChatInput,
  parameters: {
    layout: 'padded',
  },
  args: {
    onSend: (message, images) => {
      console.log('Send message:', message);
      console.log('Send images:', images);
    },
    onNewSession: () => {
      console.log('New session');
    },
  },
} satisfies Meta<typeof ChatInput>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    disabled: false,
  },
};

export const Disabled: Story = {
  args: {
    disabled: true,
  },
};

// 说明：图片粘贴功能需要在浏览器中实际粘贴 PNG 图片来测试
// 粘贴图片后会在输入框上方显示缩略图预览
