import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { CodeViewer, SimpleCodeBlock } from '@/components/project/CodeViewer';

const meta = {
  title: 'Components/CodeViewer',
  component: CodeViewer,
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
} satisfies Meta<typeof CodeViewer>;

export default meta;
type Story = StoryObj<typeof meta>;

const typescriptCode = `import { useState, useEffect } from 'react';

interface User {
  id: number;
  name: string;
  email: string;
  role: 'admin' | 'user' | 'guest';
}

export function useUser(userId: number) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);

  useEffect(() => {
    async function fetchUser() {
      try {
        setLoading(true);
        const response = await fetch(\`/api/users/\${userId}\`);
        if (!response.ok) {
          throw new Error('Failed to fetch user');
        }
        const data = await response.json();
        setUser(data);
      } catch (err) {
        setError(err instanceof Error ? err : new Error('Unknown error'));
      } finally {
        setLoading(false);
      }
    }

    fetchUser();
  }, [userId]);

  return { user, loading, error };
}`;

const pythonCode = `from typing import List, Optional
from dataclasses import dataclass
from datetime import datetime

@dataclass
class Task:
    id: int
    title: str
    completed: bool = False
    created_at: datetime = datetime.now()

class TaskManager:
    def __init__(self):
        self._tasks: List[Task] = []
        self._next_id = 1

    def add_task(self, title: str) -> Task:
        task = Task(id=self._next_id, title=title)
        self._tasks.append(task)
        self._next_id += 1
        return task

    def get_task(self, task_id: int) -> Optional[Task]:
        for task in self._tasks:
            if task.id == task_id:
                return task
        return None

    def complete_task(self, task_id: int) -> bool:
        task = self.get_task(task_id)
        if task:
            task.completed = True
            return True
        return False

    def list_tasks(self, include_completed: bool = True) -> List[Task]:
        if include_completed:
            return self._tasks
        return [t for t in self._tasks if not t.completed]`;

const jsonCode = `{
  "name": "cockpit",
  "version": "1.0.0",
  "description": "A chat demo application",
  "scripts": {
    "dev": "next dev -p 3456",
    "build": "next build",
    "start": "next start",
    "lint": "next lint",
    "storybook": "storybook dev -p 6006"
  },
  "dependencies": {
    "next": "^16.0.0",
    "react": "^19.0.0",
    "react-dom": "^19.0.0",
    "shiki": "^1.0.0"
  },
  "devDependencies": {
    "@storybook/react": "^8.0.0",
    "typescript": "^5.0.0"
  }
}`;

// Long code for virtual scrolling test
const longCode = Array.from({ length: 200 }, (_, i) =>
  `// Line ${i + 1}: This is a comment for testing virtual scrolling
const variable${i + 1} = ${i + 1};`
).join('\n');

export const TypeScript: Story = {
  args: {
    content: typescriptCode,
    filePath: 'hooks/useUser.ts',
    showLineNumbers: true,
    showSearch: true,
  },
};

export const Python: Story = {
  args: {
    content: pythonCode,
    filePath: 'task_manager.py',
    showLineNumbers: true,
    showSearch: true,
  },
};

export const JSON: Story = {
  args: {
    content: jsonCode,
    filePath: 'package.json',
    showLineNumbers: true,
    showSearch: true,
  },
};

export const NoLineNumbers: Story = {
  args: {
    content: typescriptCode,
    filePath: 'example.ts',
    showLineNumbers: false,
    showSearch: true,
  },
};

export const NoSearch: Story = {
  args: {
    content: typescriptCode,
    filePath: 'example.ts',
    showLineNumbers: true,
    showSearch: false,
  },
};

export const LongFile: Story = {
  args: {
    content: longCode,
    filePath: 'long-file.ts',
    showLineNumbers: true,
    showSearch: true,
  },
  parameters: {
    docs: {
      description: {
        story: '测试虚拟滚动性能。按 Cmd+F 打开搜索，尝试搜索 "Line 150"。',
      },
    },
  },
};

export const WithComments: Story = {
  args: {
    content: typescriptCode,
    filePath: 'hooks/useUser.ts',
    showLineNumbers: true,
    showSearch: true,
    cwd: '/Users/ka/Work/continic/Run/cockpit',
    enableComments: true,
  },
  parameters: {
    docs: {
      description: {
        story: '测试代码评论功能。悬停在行号左侧可以看到评论气泡按钮。',
      },
    },
  },
};

// SimpleCodeBlock stories
export const SimpleBlock: StoryObj<typeof SimpleCodeBlock> = {
  render: () => (
    <div className="h-[300px]">
      <SimpleCodeBlock
        content={`function hello() {
  console.log('Hello, World!');
}

hello();`}
        filePath="hello.js"
      />
    </div>
  ),
};
