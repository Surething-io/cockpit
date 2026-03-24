import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { ImagePreview } from '@/components/shared/ImagePreview';
import { ImageInfo } from '@/types/chat';

// Generate sample image data (1x1 pixel PNG)
const createMockImage = (id: string, color: string): ImageInfo => {
  // Use a simple placeholder URL as the preview
  const canvas = typeof document !== 'undefined' ? document.createElement('canvas') : null;
  let preview = `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==`;

  if (canvas) {
    canvas.width = 100;
    canvas.height = 100;
    const ctx = canvas.getContext('2d');
    if (ctx) {
      ctx.fillStyle = color;
      ctx.fillRect(0, 0, 100, 100);
      preview = canvas.toDataURL('image/png');
    }
  }

  return {
    id,
    data: preview.replace('data:image/png;base64,', ''),
    preview,
    media_type: 'image/png',
  };
};

const mockImages: ImageInfo[] = [
  createMockImage('1', '#4A90D9'),
  createMockImage('2', '#7B68EE'),
  createMockImage('3', '#50C878'),
];

const meta = {
  title: 'Components/ImagePreview',
  component: ImagePreview,
  parameters: {
    layout: 'padded',
  },
  args: {
    onRemove: (id: string) => console.log('Remove image:', id),
  },
} satisfies Meta<typeof ImagePreview>;

export default meta;
type Story = StoryObj<typeof meta>;

export const Default: Story = {
  args: {
    images: mockImages,
    disabled: false,
  },
};

export const SingleImage: Story = {
  args: {
    images: [mockImages[0]],
    disabled: false,
  },
};

export const ManyImages: Story = {
  args: {
    images: [
      ...mockImages,
      createMockImage('4', '#FFD700'),
      createMockImage('5', '#FF6347'),
      createMockImage('6', '#40E0D0'),
    ],
    disabled: false,
  },
};

export const Disabled: Story = {
  args: {
    images: mockImages,
    disabled: true,
  },
};

export const Empty: Story = {
  args: {
    images: [],
    disabled: false,
  },
};
