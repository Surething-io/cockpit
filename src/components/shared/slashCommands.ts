import { Editor } from '@tiptap/react';
import i18n from '@/lib/i18n';

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

export function getSlashCommands(): SlashCommand[] {
  return [
    {
      label: i18n.t('slashCommands.heading1'), icon: 'H1', description: i18n.t('slashCommands.heading1Desc'),
      action: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run(),
    },
    {
      label: i18n.t('slashCommands.heading2'), icon: 'H2', description: i18n.t('slashCommands.heading2Desc'),
      action: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run(),
    },
    {
      label: i18n.t('slashCommands.heading3'), icon: 'H3', description: i18n.t('slashCommands.heading3Desc'),
      action: (editor) => editor.chain().focus().toggleHeading({ level: 3 }).run(),
    },
    {
      label: i18n.t('slashCommands.bulletList'), icon: '•', description: i18n.t('slashCommands.bulletListDesc'),
      action: (editor) => editor.chain().focus().toggleBulletList().run(),
    },
    {
      label: i18n.t('slashCommands.orderedList'), icon: '1.', description: i18n.t('slashCommands.orderedListDesc'),
      action: (editor) => editor.chain().focus().toggleOrderedList().run(),
    },
    {
      label: i18n.t('slashCommands.taskList'), icon: '☑', description: i18n.t('slashCommands.taskListDesc'),
      action: (editor) => editor.chain().focus().toggleTaskList().run(),
    },
    {
      label: i18n.t('slashCommands.blockquote'), icon: '❝', description: i18n.t('slashCommands.blockquoteDesc'),
      action: (editor) => editor.chain().focus().toggleBlockquote().run(),
    },
    {
      label: i18n.t('slashCommands.codeBlock'), icon: '<>', description: i18n.t('slashCommands.codeBlockDesc'),
      action: (editor) => editor.chain().focus().toggleCodeBlock().run(),
    },
    {
      label: i18n.t('slashCommands.table'), icon: '▦', description: i18n.t('slashCommands.tableDesc'),
      action: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run(),
    },
    {
      label: i18n.t('slashCommands.horizontalRule'), icon: '──', description: i18n.t('slashCommands.horizontalRuleDesc'),
      action: (editor) => editor.chain().focus().setHorizontalRule().run(),
    },
    {
      label: i18n.t('slashCommands.link'), icon: '🔗', description: i18n.t('slashCommands.linkDesc'),
      action: (_editor) => {
        window.dispatchEvent(new CustomEvent('tiptap-insert-link'));
      },
    },
  ];
}

/** @deprecated Use getSlashCommands() instead for i18n support */
export const slashCommands = getSlashCommands();
