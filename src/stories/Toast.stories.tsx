import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ToastProvider, useToast } from '@/components/Toast';
import { useEffect } from 'react';

// Demo component that triggers toasts
function ToastDemo({ type, message }: { type: 'success' | 'error' | 'info'; message: string }) {
  const { showToast } = useToast();

  return (
    <button
      onClick={() => showToast(message, type)}
      className={`px-4 py-2 rounded text-white ${
        type === 'success' ? 'bg-green-9' : type === 'error' ? 'bg-red-9' : 'bg-brand'
      }`}
    >
      显示 {type === 'success' ? '成功' : type === 'error' ? '错误' : '信息'} Toast
    </button>
  );
}

// Auto-show demo for initial display
function AutoShowDemo({ type, message }: { type: 'success' | 'error' | 'info'; message: string }) {
  const { showToast } = useToast();

  useEffect(() => {
    showToast(message, type);
  }, [showToast, message, type]);

  return (
    <button
      onClick={() => showToast(message, type)}
      className={`px-4 py-2 rounded text-white ${
        type === 'success' ? 'bg-green-9' : type === 'error' ? 'bg-red-9' : 'bg-brand'
      }`}
    >
      再次显示
    </button>
  );
}

// Multiple toasts demo
function MultipleToastsDemo() {
  const { showToast } = useToast();

  const showMultiple = () => {
    showToast('文件已保存', 'success');
    setTimeout(() => showToast('正在同步...', 'info'), 300);
    setTimeout(() => showToast('同步完成', 'success'), 600);
  };

  return (
    <button
      onClick={showMultiple}
      className="px-4 py-2 rounded bg-brand text-white"
    >
      显示多个 Toast
    </button>
  );
}

const meta: Meta<typeof ToastProvider> = {
  title: 'Components/Toast',
  component: ToastProvider,
  parameters: {
    layout: 'centered',
  },
  decorators: [
    (Story) => (
      <ToastProvider>
        <Story />
      </ToastProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof ToastProvider>;

export const Success: Story = {
  render: () => <AutoShowDemo type="success" message="操作成功！" />,
};

export const Error: Story = {
  render: () => <AutoShowDemo type="error" message="操作失败，请重试" />,
};

export const Info: Story = {
  render: () => <AutoShowDemo type="info" message="这是一条提示信息" />,
};

export const Interactive: Story = {
  render: () => (
    <div className="flex gap-4">
      <ToastDemo type="success" message="保存成功" />
      <ToastDemo type="error" message="删除失败" />
      <ToastDemo type="info" message="正在处理..." />
    </div>
  ),
};

export const Multiple: Story = {
  render: () => <MultipleToastsDemo />,
};
