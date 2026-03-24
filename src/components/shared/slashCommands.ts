import { Editor } from '@tiptap/react';

// ============================================
// Markdown extraction helpers
// ============================================

export function getMarkdown(editor: Editor): string {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (editor.storage as any).markdown.getMarkdown() as string;
}

// ============================================
// Slash command definitions
// ============================================

export interface SlashCommand {
  label: string;
  icon: string;
  description: string;
  action: (editor: Editor) => void;
}

export const slashCommands: SlashCommand[] = [
  {
    label: '标题 1', icon: 'H1', description: '大标题',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
  },
  {
    label: '标题 2', icon: 'H2', description: '中标题',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
  },
  {
    label: '标题 3', icon: 'H3', description: '小标题',
    action: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
  },
  {
    label: '无序列表', icon: '•', description: '项目符号列表',
    action: (editor) => editor.chain().focus().toggleBulletList().run(),
  },
  {
    label: '有序列表', icon: '1.', description: '编号列表',
    action: (editor) => editor.chain().focus().toggleOrderedList().run(),
  },
  {
    label: '待办列表', icon: '☑', description: '可勾选的任务列表',
    action: (editor) => editor.chain().focus().toggleTaskList().run(),
  },
  {
    label: '引用', icon: '❝', description: '引用块',
    action: (editor) => editor.chain().focus().toggleBlockquote().run(),
  },
  {
    label: '代码块', icon: '<>', description: '代码片段',
    action: (editor) => editor.chain().focus().toggleCodeBlock().run(),
  },
  {
    label: '表格', icon: '▦', description: '插入 3×3 表格',
    action: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
  },
  {
    label: '分割线', icon: '──', description: '水平分割线',
    action: (editor) => editor.chain().focus().setHorizontalRule().run(),
  },
  {
    label: '链接', icon: '🔗', description: '插入超链接',
    action: (_editor) => {
      window.dispatchEvent(new CustomEvent('tiptap-insert-link'));
    },
  },
];
