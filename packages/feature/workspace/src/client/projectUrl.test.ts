import { describe, expect, it } from 'vitest';
import { buildProjectUrl } from './projectUrl';

describe('buildProjectUrl', () => {
  it('carries a selected session into the project frame', () => {
    expect(buildProjectUrl('/work/a b', { sessionId: 'session/1', switchToAgent: true }))
      .toBe('/project?cwd=%2Fwork%2Fa%20b&sessionId=session%2F1&view=agent');
  });

  it('reveals a file in the Explorer, panel included', () => {
    expect(buildProjectUrl('/bots/robert', { file: 'BOT.md' }))
      .toBe('/project?cwd=%2Fbots%2Frobert&file=BOT.md&view=explorer');
  });

  it('emits one view even when both intents were frozen on the same project', () => {
    // A session link lands on an unmounted project, then the Bots panel opens
    // that same directory: two `view` values would parse as string[] and match
    // neither panel.
    const url = buildProjectUrl('/bots/robert', { sessionId: 's1', switchToAgent: true, file: 'BOT.md' });
    expect(url.match(/view=/g)).toHaveLength(1);
    expect(url).toContain('view=explorer');
  });

  it('reveals a terminal bubble in the Console, panel included', () => {
    expect(buildProjectUrl('/work/p', { bubble: 'cmd-1-abc' }))
      .toBe('/project?cwd=%2Fwork%2Fp&bubble=cmd-1-abc&view=console');
    // A session frozen earlier on the same project keeps its id, but the
    // bubble decides the panel.
    const url = buildProjectUrl('/work/p', { sessionId: 's1', switchToAgent: true, bubble: 'cmd-1' });
    expect(url).toContain('sessionId=s1');
    expect(url.match(/view=/g)).toHaveLength(1);
    expect(url).toContain('view=console');
  });

  it('distinguishes a blank active tab from an unspecified active tab', () => {
    expect(buildProjectUrl('/work/project', { blank: true }))
      .toBe('/project?cwd=%2Fwork%2Fproject&newChat=1');
    expect(buildProjectUrl('/work/project'))
      .toBe('/project?cwd=%2Fwork%2Fproject');
  });
});
