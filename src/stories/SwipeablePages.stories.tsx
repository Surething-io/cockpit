import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { useState } from 'react';
import { SwipeablePages } from '@/components/SwipeablePages';

const meta: Meta<typeof SwipeablePages> = {
  title: 'Components/SwipeablePages',
  component: SwipeablePages,
  parameters: {
    layout: 'fullscreen',
  },
};

export default meta;
type Story = StoryObj<typeof SwipeablePages>;

// Interactive demo component
function SwipeableDemo() {
  const [currentPage, setCurrentPage] = useState(0);

  return (
    <div className="h-[400px] flex flex-col">
      {/* Header with page indicator */}
      <div className="flex-shrink-0 p-4 border-b border-border bg-card">
        <div className="flex items-center justify-between">
          <h3 className="font-medium">SwipeablePages Demo</h3>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setCurrentPage(0)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                currentPage === 0 ? 'bg-brand text-white' : 'bg-accent'
              }`}
            >
              页面 1
            </button>
            <button
              onClick={() => setCurrentPage(1)}
              className={`px-3 py-1 rounded text-sm transition-colors ${
                currentPage === 1 ? 'bg-brand text-white' : 'bg-accent'
              }`}
            >
              页面 2
            </button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground mt-2">
          使用触摸板双指左右滑动切换页面
        </p>
      </div>

      {/* Swipeable content */}
      <SwipeablePages
        currentPage={currentPage}
        onPageChange={setCurrentPage}
      >
        {/* Page 1 */}
        <div className="h-full bg-gradient-to-br from-blue-9/20 to-blue-9/5 p-6">
          <h2 className="text-2xl font-bold mb-4">第一页</h2>
          <p className="text-muted-foreground mb-4">
            这是第一个页面的内容。向左滑动可以切换到第二页。
          </p>
          <div className="space-y-2">
            <div className="p-3 bg-card rounded-lg">项目 1</div>
            <div className="p-3 bg-card rounded-lg">项目 2</div>
            <div className="p-3 bg-card rounded-lg">项目 3</div>
          </div>
        </div>

        {/* Page 2 */}
        <div className="h-full bg-gradient-to-br from-green-9/20 to-green-9/5 p-6">
          <h2 className="text-2xl font-bold mb-4">第二页</h2>
          <p className="text-muted-foreground mb-4">
            这是第二个页面的内容。向右滑动可以切换回第一页。
          </p>
          <div className="grid grid-cols-2 gap-2">
            <div className="p-3 bg-card rounded-lg text-center">A</div>
            <div className="p-3 bg-card rounded-lg text-center">B</div>
            <div className="p-3 bg-card rounded-lg text-center">C</div>
            <div className="p-3 bg-card rounded-lg text-center">D</div>
          </div>
        </div>
      </SwipeablePages>

      {/* Footer with dots indicator */}
      <div className="flex-shrink-0 p-4 border-t border-border bg-card">
        <div className="flex justify-center gap-2">
          <div className={`w-2 h-2 rounded-full transition-colors ${
            currentPage === 0 ? 'bg-brand' : 'bg-accent'
          }`} />
          <div className={`w-2 h-2 rounded-full transition-colors ${
            currentPage === 1 ? 'bg-brand' : 'bg-accent'
          }`} />
        </div>
      </div>
    </div>
  );
}

// Chat-like demo
function ChatSwipeDemo() {
  const [currentPage, setCurrentPage] = useState(0);

  return (
    <div className="h-[500px] flex flex-col bg-background">
      {/* Tabs */}
      <div className="flex-shrink-0 flex border-b border-border">
        <button
          onClick={() => setCurrentPage(0)}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            currentPage === 0
              ? 'text-brand border-b-2 border-brand'
              : 'text-muted-foreground'
          }`}
        >
          聊天
        </button>
        <button
          onClick={() => setCurrentPage(1)}
          className={`flex-1 py-3 text-sm font-medium transition-colors ${
            currentPage === 1
              ? 'text-brand border-b-2 border-brand'
              : 'text-muted-foreground'
          }`}
        >
          文件
        </button>
      </div>

      {/* Content */}
      <SwipeablePages
        currentPage={currentPage}
        onPageChange={setCurrentPage}
      >
        {/* Chat page */}
        <div className="h-full flex flex-col">
          <div className="flex-1 overflow-auto p-4 space-y-4">
            <div className="flex justify-end">
              <div className="bg-brand text-white px-4 py-2 rounded-2xl rounded-tr-sm max-w-[80%]">
                你好！
              </div>
            </div>
            <div className="flex justify-start">
              <div className="bg-accent px-4 py-2 rounded-2xl rounded-tl-sm max-w-[80%]">
                你好！有什么我可以帮助你的吗？
              </div>
            </div>
            <div className="flex justify-end">
              <div className="bg-brand text-white px-4 py-2 rounded-2xl rounded-tr-sm max-w-[80%]">
                帮我看一下代码
              </div>
            </div>
          </div>
          <div className="flex-shrink-0 p-4 border-t border-border">
            <input
              type="text"
              placeholder="输入消息..."
              className="w-full px-4 py-2 rounded-lg border border-border bg-card"
            />
          </div>
        </div>

        {/* Files page */}
        <div className="h-full overflow-auto p-4">
          <div className="space-y-2">
            {['src/', 'package.json', 'tsconfig.json', 'README.md'].map((file) => (
              <div
                key={file}
                className="flex items-center gap-2 p-3 rounded-lg hover:bg-accent cursor-pointer"
              >
                <svg className="w-5 h-5 text-muted-foreground" fill="currentColor" viewBox="0 0 20 20">
                  {file.endsWith('/') ? (
                    <path d="M2 6a2 2 0 012-2h5l2 2h5a2 2 0 012 2v6a2 2 0 01-2 2H4a2 2 0 01-2-2V6z" />
                  ) : (
                    <path fillRule="evenodd" d="M4 4a2 2 0 012-2h4.586A2 2 0 0112 2.586L15.414 6A2 2 0 0116 7.414V16a2 2 0 01-2 2H6a2 2 0 01-2-2V4z" clipRule="evenodd" />
                  )}
                </svg>
                <span className="text-sm">{file}</span>
              </div>
            ))}
          </div>
        </div>
      </SwipeablePages>
    </div>
  );
}

export const Default: Story = {
  render: () => <SwipeableDemo />,
};

export const StartOnPageTwo: Story = {
  render: () => {
    const [currentPage, setCurrentPage] = useState(1);
    return (
      <div className="h-[300px]">
        <SwipeablePages currentPage={currentPage} onPageChange={setCurrentPage}>
          <div className="h-full bg-blue-9/10 flex items-center justify-center">
            <span className="text-xl">第一页</span>
          </div>
          <div className="h-full bg-green-9/10 flex items-center justify-center">
            <span className="text-xl">第二页（初始）</span>
          </div>
        </SwipeablePages>
      </div>
    );
  },
};

export const ChatDemo: Story = {
  render: () => <ChatSwipeDemo />,
  parameters: {
    docs: {
      description: {
        story: '模拟聊天应用中的页面切换效果，可在聊天和文件列表之间滑动切换',
      },
    },
  },
};
