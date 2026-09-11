import { describe, expect, it } from 'vitest';
import { isInstructionGroup, type InstructionNode } from './effect/agentClient';
import { formatInstructionsMarkdown, parseInstructionsMarkdown } from './quickInstructionsMarkdown';

const withoutIds = (nodes: InstructionNode[]) => nodes.map((node) => isInstructionGroup(node)
  ? { name: node.name, items: node.items.map((item) => item.text) }
  : node.text);

describe('quick-instruction Markdown outline', () => {
  it('formats top-level entries without markers and group children with markers', () => {
    const nodes: InstructionNode[] = [
      { id: 'a', text: 'Continue' },
      { id: 'g', name: 'Draw with text', items: [
        { id: 'b', text: 'Draw a flow' },
        { id: 'c', text: 'Draw an architecture' },
      ] },
    ];

    expect(formatInstructionsMarkdown(nodes)).toBe(
      'Continue\nDraw with text\n- Draw a flow\n- Draw an architecture'
    );
  });

  it('parses loose instructions and groups in their original order', () => {
    const parsed = parseInstructionsMarkdown(
      'Continue\nDraw with text\n- Draw a flow\n- Draw an architecture\nDone'
    );

    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(withoutIds(parsed.nodes)).toEqual([
      'Continue',
      { name: 'Draw with text', items: ['Draw a flow', 'Draw an architecture'] },
      'Done',
    ]);
  });

  it('ignores blank lines', () => {
    const parsed = parseInstructionsMarkdown('One\n\nGroup\n- Two\n');
    expect(parsed.ok && withoutIds(parsed.nodes)).toEqual([
      'One',
      { name: 'Group', items: ['Two'] },
    ]);
  });

  it('reports an orphan child line', () => {
    expect(parseInstructionsMarkdown('- orphan')).toEqual({ ok: false, line: 1 });
  });

  it('round-trips an empty group with an empty child marker', () => {
    const nodes: InstructionNode[] = [{ id: 'g', name: 'Empty group', items: [] }];
    const text = formatInstructionsMarkdown(nodes);
    expect(text).toBe('Empty group\n- ');
    const parsed = parseInstructionsMarkdown(text);
    expect(parsed.ok && withoutIds(parsed.nodes)).toEqual([{ name: 'Empty group', items: [] }]);
  });

  it('accepts indentation before a child marker', () => {
    const parsed = parseInstructionsMarkdown('Group\n  - child');
    expect(parsed.ok && withoutIds(parsed.nodes)).toEqual([
      { name: 'Group', items: ['child'] },
    ]);
  });

  it('reports indented text without a child marker', () => {
    expect(parseInstructionsMarkdown('Group\n  child')).toEqual({ ok: false, line: 2 });
  });
});
