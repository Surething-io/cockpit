import type { Meta, StoryObj } from '@storybook/nextjs-vite';
import { MarkdownRenderer } from '@/components/shared/MarkdownRenderer';

const meta = {
  title: 'Components/MarkdownRenderer',
  component: MarkdownRenderer,
  parameters: {
    layout: 'padded',
  },
  decorators: [
    (Story) => (
      <div className="max-w-2xl mx-auto p-4">
        <Story />
      </div>
    ),
  ],
} satisfies Meta<typeof MarkdownRenderer>;

export default meta;
type Story = StoryObj<typeof meta>;

export const BasicText: Story = {
  args: {
    content: `# 标题一

这是一段普通文本。

## 标题二

这里有**粗体**和*斜体*文字，还有~~删除线~~。

### 标题三

这是一个段落，包含一些内容。`,
  },
};

export const CodeBlock: Story = {
  args: {
    content: `下面是一段 TypeScript 代码：

\`\`\`typescript
interface User {
  id: number;
  name: string;
  email: string;
}

function greet(user: User): string {
  return \`Hello, \${user.name}!\`;
}
\`\`\`

你也可以使用 \`inline code\` 来显示行内代码。

Python 代码示例：

\`\`\`python
def fibonacci(n):
    if n <= 1:
        return n
    return fibonacci(n - 1) + fibonacci(n - 2)

print(fibonacci(10))
\`\`\``,
  },
};

export const Lists: Story = {
  args: {
    content: `## 无序列表

- 第一项
- 第二项
- 第三项

## 有序列表

1. 步骤一
2. 步骤二
3. 步骤三`,
  },
};

export const Table: Story = {
  args: {
    content: `## 表格示例

| 功能 | 状态 | 备注 |
|------|------|------|
| 登录 | 完成 | 已测试 |
| 注册 | 进行中 | 待测试 |
| 忘记密码 | 待开始 | - |`,
  },
};

export const Blockquote: Story = {
  args: {
    content: `## 引用示例

> 这是一段引用文字。
> 可以跨越多行。

普通文字在这里。

> 另一段引用。`,
  },
};

export const Links: Story = {
  args: {
    content: `## 链接示例

这里有一个 [链接到 GitHub](https://github.com)。

也可以是 [Anthropic](https://anthropic.com) 的链接。`,
  },
};

export const Mixed: Story = {
  args: {
    content: `# Claude 使用指南

## 简介

Claude 是 Anthropic 开发的 AI 助手。它可以帮助你完成各种任务。

## 功能特点

1. **对话能力** - 自然流畅的对话
2. **代码生成** - 支持多种编程语言
3. **文档写作** - 帮助撰写各类文档

## 代码示例

\`\`\`javascript
// 使用 Claude API
const response = await anthropic.messages.create({
  model: 'claude-3-opus-20240229',
  max_tokens: 1024,
  messages: [
    { role: 'user', content: 'Hello, Claude!' }
  ]
});
\`\`\`

> 提示：确保在使用前设置好 API 密钥。

## 更多信息

| 资源 | 链接 |
|------|------|
| 文档 | [docs.anthropic.com](https://docs.anthropic.com) |
| API | [api.anthropic.com](https://api.anthropic.com) |

---

如有问题，欢迎反馈！`,
  },
};

export const UserMessage: Story = {
  args: {
    content: '这是用户发送的消息，不会渲染 Markdown，直接显示纯文本。\n\n**这不会变粗体**\n\n```这不是代码块```',
    isUser: true,
  },
};
