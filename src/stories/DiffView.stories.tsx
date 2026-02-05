import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { DiffView, DiffUnifiedView } from '@/components/project/DiffView';

const meta = {
  title: 'Components/DiffView',
  component: DiffView,
  parameters: {
    layout: 'fullscreen',
  },
  decorators: [
    (Story) => (
      <div className="h-[500px] p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof DiffView>;

export default meta;
type Story = StoryObj<typeof meta>;

const oldCode = `import { useState } from 'react';

interface Props {
  name: string;
}

export function Greeting({ name }: Props) {
  const [count, setCount] = useState(0);

  return (
    <div>
      <h1>Hello, {name}!</h1>
      <p>Count: {count}</p>
      <button onClick={() => setCount(count + 1)}>
        Increment
      </button>
    </div>
  );
}`;

const newCode = `import { useState, useCallback } from 'react';

interface Props {
  name: string;
  initialCount?: number;
}

export function Greeting({ name, initialCount = 0 }: Props) {
  const [count, setCount] = useState(initialCount);

  const handleIncrement = useCallback(() => {
    setCount(prev => prev + 1);
  }, []);

  const handleDecrement = useCallback(() => {
    setCount(prev => Math.max(0, prev - 1));
  }, []);

  return (
    <div className="greeting-container">
      <h1>Hello, {name}!</h1>
      <p>Current count: {count}</p>
      <div className="button-group">
        <button onClick={handleDecrement}>-</button>
        <button onClick={handleIncrement}>+</button>
      </div>
    </div>
  );
}`;

export const SmallChange: Story = {
  args: {
    oldContent: `function add(a, b) {
  return a + b;
}`,
    newContent: `function add(a: number, b: number): number {
  return a + b;
}`,
    filePath: 'math.ts',
  },
};

export const LargeChange: Story = {
  args: {
    oldContent: oldCode,
    newContent: newCode,
    filePath: 'Greeting.tsx',
  },
};

export const NewFile: Story = {
  args: {
    oldContent: '',
    newContent: `export const API_URL = 'https://api.example.com';
export const TIMEOUT = 5000;
export const MAX_RETRIES = 3;`,
    filePath: 'config.ts',
    isNew: true,
  },
};

export const DeletedFile: Story = {
  args: {
    oldContent: `// This file is no longer needed
export function deprecated() {
  console.warn('This function is deprecated');
}`,
    newContent: '',
    filePath: 'deprecated.ts',
    isDeleted: true,
  },
};

export const OnlyAdditions: Story = {
  args: {
    oldContent: `interface User {
  id: number;
  name: string;
}`,
    newContent: `interface User {
  id: number;
  name: string;
  email: string;
  createdAt: Date;
  updatedAt: Date;
}`,
    filePath: 'types.ts',
  },
};

export const OnlyDeletions: Story = {
  args: {
    oldContent: `interface User {
  id: number;
  name: string;
  email: string;
  password: string;
  salt: string;
}`,
    newContent: `interface User {
  id: number;
  name: string;
  email: string;
}`,
    filePath: 'types.ts',
  },
};

// Unified view stories
export const UnifiedSmallChange: StoryObj<typeof DiffUnifiedView> = {
  render: () => (
    <DiffUnifiedView
      oldContent={`function add(a, b) {
  return a + b;
}`}
      newContent={`function add(a: number, b: number): number {
  return a + b;
}`}
      filePath="math.ts"
    />
  ),
};

export const UnifiedLargeChange: StoryObj<typeof DiffUnifiedView> = {
  render: () => (
    <DiffUnifiedView
      oldContent={oldCode}
      newContent={newCode}
      filePath="Greeting.tsx"
    />
  ),
};
