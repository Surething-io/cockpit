import {
  isInstructionGroup,
  type InstructionNode,
} from './effect/agentClient';

const tempId = () => Math.random().toString(36).slice(2, 10);

/**
 * Human-editable outline:
 *
 *   Loose instruction
 *   Group name
 *   - instruction in the group
 *
 * A top-level line becomes a group only when it owns indented list items.
 * Empty groups therefore intentionally collapse to loose instructions: without
 * children there is no syntax-level distinction for the editor to preserve.
 */
export function formatInstructionsMarkdown(nodes: InstructionNode[]): string {
  return nodes.flatMap((node) => isInstructionGroup(node)
    ? [node.name, ...(node.items.length > 0 ? node.items.map((item) => `- ${item.text}`) : ['- '])]
    : [node.text]
  ).join('\n');
}

export type ParseInstructionsResult =
  | { ok: true; nodes: InstructionNode[] }
  | { ok: false; line: number };

export function parseInstructionsMarkdown(text: string): ParseInstructionsResult {
  const entries: Array<{ text: string; children: string[]; isGroup: boolean }> = [];
  let current: { text: string; children: string[]; isGroup: boolean } | null = null;

  for (const [index, rawLine] of text.split(/\r?\n/).entries()) {
    if (!rawLine.trim()) continue;

    const child = rawLine.match(/^\s*-(?:\s+(.*))?$/);
    if (child) {
      const childText = (child[1] ?? '').trim();
      if (!current) return { ok: false, line: index + 1 };
      current.isGroup = true;
      if (childText) current.children.push(childText);
      continue;
    }

    // Top-level entries are deliberately flush-left and have no list marker.
    if (/^\s/.test(rawLine)) {
      return { ok: false, line: index + 1 };
    }

    const rootText = rawLine.trim();
    if (!rootText) continue;
    current = { text: rootText, children: [], isGroup: false };
    entries.push(current);
  }

  return {
    ok: true,
    nodes: entries.map((entry) => entry.isGroup
      ? {
          id: tempId(),
          name: entry.text,
          items: entry.children.map((text) => ({ id: tempId(), text })),
        }
      : { id: tempId(), text: entry.text }),
  };
}
