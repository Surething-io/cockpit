import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { FileContextMenu, FileContextMenuWrapper, MenuContainerProvider } from '@/components/FileContextMenu';
import { ToastProvider } from '@/components/Toast';

const meta = {
  title: 'Components/FileContextMenu',
  component: FileContextMenu,
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
} satisfies Meta<typeof FileContextMenu>;

export default meta;
type Story = StoryObj<typeof meta>;

// Interactive demo component
function ContextMenuDemo({ path, isDirectory }: { path: string; isDirectory: boolean }) {
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div className="relative">
      <div
        className="p-4 border border-border rounded-lg bg-card cursor-pointer select-none hover:bg-accent transition-colors"
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({ x: e.clientX, y: e.clientY });
        }}
      >
        <div className="flex items-center gap-2">
          {isDirectory ? (
            <svg className="w-5 h-5 text-amber-9" fill="currentColor" viewBox="0 0 20 20">
              <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
            </svg>
          ) : (
            <svg className="w-5 h-5 text-slate-9" fill="currentColor" viewBox="0 0 20 20">
              <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
            </svg>
          )}
          <span className="text-sm">{path.split('/').pop()}</span>
        </div>
        <p className="text-xs text-muted-foreground mt-2">右键点击打开菜单</p>
      </div>

      {menu && (
        <FileContextMenu
          x={menu.x}
          y={menu.y}
          path={path}
          cwd="/Users/demo/project"
          isDirectory={isDirectory}
          onClose={() => setMenu(null)}
        />
      )}
    </div>
  );
}

// Wrapper demo
function WrapperDemo() {
  return (
    <div className="space-y-2">
      <FileContextMenuWrapper
        path="src/components/Button.tsx"
        cwd="/Users/demo/project"
        isDirectory={false}
        className="p-3 border border-border rounded-lg bg-card cursor-pointer hover:bg-accent transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-blue-9" fill="currentColor" viewBox="0 0 20 20">
            <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
          </svg>
          <span className="text-sm">Button.tsx</span>
        </div>
      </FileContextMenuWrapper>

      <FileContextMenuWrapper
        path="src/utils"
        cwd="/Users/demo/project"
        isDirectory={true}
        className="p-3 border border-border rounded-lg bg-card cursor-pointer hover:bg-accent transition-colors"
      >
        <div className="flex items-center gap-2">
          <svg className="w-5 h-5 text-amber-9" fill="currentColor" viewBox="0 0 20 20">
            <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
          </svg>
          <span className="text-sm">utils/</span>
        </div>
      </FileContextMenuWrapper>

      <p className="text-xs text-muted-foreground text-center pt-2">
        右键点击任意项目打开菜单
      </p>
    </div>
  );
}

// In container demo
function InContainerDemo() {
  const [container, setContainer] = useState<HTMLDivElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);

  return (
    <div
      ref={setContainer}
      className="relative w-80 h-60 border border-border rounded-lg bg-card overflow-hidden"
    >
      <MenuContainerProvider container={container}>
        <div className="p-4 h-full">
          <p className="text-sm mb-4">菜单会限制在容器内显示：</p>
          <div
            className="p-3 border border-dashed border-border rounded cursor-pointer hover:bg-accent"
            onContextMenu={(e) => {
              e.preventDefault();
              setMenu({ x: e.clientX, y: e.clientY });
            }}
          >
            <span className="text-sm">右键点击这里</span>
          </div>

          {menu && (
            <FileContextMenu
              x={menu.x}
              y={menu.y}
              path="src/deep/nested/path/file.ts"
              cwd="/Users/demo/project"
              isDirectory={false}
              onClose={() => setMenu(null)}
            />
          )}
        </div>
      </MenuContainerProvider>
    </div>
  );
}

export const FileMenu: Story = {
  render: () => <ContextMenuDemo path="src/components/Button.tsx" isDirectory={false} />,
};

export const DirectoryMenu: Story = {
  render: () => <ContextMenuDemo path="src/components" isDirectory={true} />,
};

export const DeepPath: Story = {
  render: () => <ContextMenuDemo path="src/features/auth/hooks/useAuth.ts" isDirectory={false} />,
};

export const UsingWrapper: Story = {
  render: () => <WrapperDemo />,
};

export const InContainer: Story = {
  render: () => <InContainerDemo />,
  parameters: {
    docs: {
      description: {
        story: '菜单会自动调整位置，确保不超出容器边界',
      },
    },
  },
};
