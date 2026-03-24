import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ChatInput } from '@/components/project/ChatInput';

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

// Note: The image paste feature requires actually pasting a PNG image in the browser to test.
// After pasting, a thumbnail preview will appear above the input field.
