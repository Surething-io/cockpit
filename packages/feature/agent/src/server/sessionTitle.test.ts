import { describe, expect, it } from 'vitest';
import { generateTitle } from './sessionTitle';
import { footerHeader } from '../shared/commandPrompt';
import { sentOriginLine } from '../shared/messageOrigin';

describe('generateTitle', () => {
  it('titles a resolved command message by what was typed, not its footer', () => {
    const stored = `[cr] 看一下最近 1 个提交\n\n${footerHeader('read', 'zh')}\n- cr：/x/skills/cr/SKILL.md`;
    expect(generateTitle('', '', [stored, 'next message'])).toBe('/cr 看一下最近 1 个提交');
    const session = `[session·@Payments fix] status?\n\n${footerHeader('read', 'en')}\n- session-run: /x/SKILL.md\n\n${footerHeader('targets', 'en')}\n- @Payments fix: {"cwd":"/w","sessionId":"s"}`;
    expect(generateTitle('', '', [session])).toBe('@Payments fix status?');
  });

  it('still joins a lone /command with the message that follows it', () => {
    expect(generateTitle('', '', ['/qa', 'define the sidebar'])).toBe('/qa define the sidebar');
  });

  it('drops the origin line of a message another session sent', () => {
    expect(generateTitle('', '', [`${sentOriginLine('/project?cwd=%2Fa&sessionId=s', 'a')}\n\nwhat changed?`])).toBe('what changed?');
  });

  it('titles a Codex session the same way, without the delegation origin line', async () => {
    const { generateCodexTitle } = await import('./sessionTitle');
    const { delegatedOriginLine } = await import('../shared/messageOrigin');
    const first = `Task: cr: session Bots\n${delegatedOriginLine('/project?cwd=%2Fa&sessionId=s', 'a')}\n\nRead this task brief first`;
    expect(generateCodexTitle(first)).toBe('Task: cr: session Bots\n\nRead this task brief first'.slice(0, 80));
    expect(generateCodexTitle(first)).not.toContain('Delegated from');
    expect(generateCodexTitle(null)).toBe('Untitled Session');
  });

  it('previews a Codex session as typed, keeping its own <command-*>-looking text', async () => {
    const { previewMessages } = await import('./transcriptViews');
    const turn = (text: string) => ({ isMeta: false, blocks: [text], listText: text });
    const stored = `[cr] review this\n\n${footerHeader('read', 'en')}\n- cr: /x/skills/cr/SKILL.md`;
    const sent = `${sentOriginLine('/project?cwd=%2Fa&sessionId=s', 'a', 'in-1')}\n\nwhat changed?`;
    const snap = { format: 'codex', userTurns: [turn(stored), turn(sent), turn('<command-name>my XML</command-name>')] };
    expect(previewMessages(snap as unknown as Parameters<typeof previewMessages>[0]))
      .toEqual(['/cr review this', 'what changed?', '<command-name>my XML</command-name>']);
  });
});
