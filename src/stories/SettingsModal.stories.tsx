import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { SettingsModal } from '@/components/shared/SettingsModal';
import { ThemeProvider } from '@/components/shared/ThemeProvider';

const meta: Meta<typeof SettingsModal> = {
  title: 'Components/SettingsModal',
  component: SettingsModal,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <ThemeProvider>
        <div className="h-screen bg-background">
          <Story />
        </div>
      </ThemeProvider>
    ),
  ],
};

export default meta;
type Story = StoryObj<typeof SettingsModal>;

export const Default: Story = {
  args: {
    isOpen: true,
    onClose: () => console.log('Close clicked'),
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

// Interactive demo showing theme switching
function InteractiveDemo() {
  const [isOpen, setIsOpen] = useState(true);
  return (
    <>
      <div className="p-4">
        <button
          onClick={() => setIsOpen(true)}
          className="px-4 py-2 bg-brand text-white rounded hover:bg-brand/90"
        >
          打开设置
        </button>
        <p className="mt-4 text-sm text-muted-foreground">
          切换主题后，整个页面的配色会相应变化
        </p>
      </div>
      <SettingsModal isOpen={isOpen} onClose={() => setIsOpen(false)} />
    </>
  );
}

export const Interactive: Story = {
  render: () => <InteractiveDemo />,
};
