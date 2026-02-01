import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { Tooltip } from '@/components/Tooltip';

const meta = {
  title: 'Components/Tooltip',
  component: Tooltip,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <div className="p-20">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof Tooltip>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    content: '这是一个提示信息',
    children: (
      <button className="px-4 py-2 bg-brand text-white rounded hover:bg-brand/90">
        悬停查看提示
      </button>
    ),
  },
};

export const LongContent: Story = {
  args: {
    content: '这是一段很长的提示信息，用于测试 Tooltip 的自动换行功能。当文本内容超过最大宽度时，会自动换行显示。',
    children: (
      <button className="px-4 py-2 bg-brand text-white rounded hover:bg-brand/90">
        长文本提示
      </button>
    ),
  },
};

export const CustomDelay: Story = {
  args: {
    content: '延迟 500ms 后显示',
    delay: 500,
    children: (
      <button className="px-4 py-2 bg-brand text-white rounded hover:bg-brand/90">
        自定义延迟
      </button>
    ),
  },
};

export const ZeroDelay: Story = {
  args: {
    content: '立即显示',
    delay: 0,
    children: (
      <button className="px-4 py-2 bg-brand text-white rounded hover:bg-brand/90">
        无延迟
      </button>
    ),
  },
};

export const OnIcon: Story = {
  args: {
    content: '复制到剪贴板',
    children: (
      <button className="p-2 rounded hover:bg-accent">
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
        </svg>
      </button>
    ),
  },
};
