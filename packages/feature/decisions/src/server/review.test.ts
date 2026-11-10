import { describe, expect, it } from 'vitest';
import type { SnapshotWindowCommit } from '@cockpit/effect-services';
import { attribute, categorize, collectTouches, toToplevelPath } from './review';

let n = 0;
const commit = (over: Partial<SnapshotWindowCommit>): SnapshotWindowCommit => ({
  hash: `h${++n}`,
  parent: 'p',
  timestamp: n,
  subject: '',
  sessionKey: 'S1',
  toolId: null,
  toolName: null,
  toolFiles: [],
  provider: 'claude',
  baseline: false,
  files: [],
  ...over,
});

describe('review attribution (§4.3)', () => {
  const own = new Set(['t1', 't2', 't3']);
  const window = [
    commit({ toolId: 't1', toolName: 'Edit', toolFiles: ['a.ts'], files: ['a.ts', 'drift.ts'] }),
    commit({ toolId: 'o1', sessionKey: 'S2', toolName: 'Edit', toolFiles: ['b.ts'], files: ['b.ts', 'shared.ts'] }),
    commit({ toolId: 't2', toolName: 'Bash', files: ['gen.ts', 'shared.ts'] }),
    commit({ baseline: true, sessionKey: 'S1', files: ['editor.ts'] }),
    commit({ toolId: 't3', toolName: 'Write', toolFiles: ['c.ts'], files: ['c.ts'] }),
  ];
  const touches = collectTouches(window, own);

  it('classifies every case in the table', () => {
    expect(attribute('a.ts', touches).category).toBe('task');
    expect(attribute('c.ts', touches).category).toBe('task');
    expect(attribute('gen.ts', touches).category).toBe('task-maybe');
    expect(attribute('drift.ts', touches).category).toBe('non-agent');
    expect(attribute('editor.ts', touches).category).toBe('non-agent');
    expect(attribute('b.ts', touches)).toEqual({ category: 'other-session', otherSessions: ['S2'] });
    expect(attribute('shared.ts', touches)).toEqual({ category: 'mixed', otherSessions: ['S2'] });
  });

  it('a file no window commit explains is not attributed to the task', () => {
    expect(attribute('nowhere.ts', touches).category).toBe('non-agent');
    expect(categorize(undefined)).toBe('non-agent');
  });

  it('declared beats Bash for the same file', () => {
    const t = collectTouches(
      [commit({ toolId: 't1', toolName: 'Bash', files: ['x.ts'] }), commit({ toolId: 't2', toolName: 'Edit', toolFiles: ['x.ts'], files: ['x.ts'] })],
      own,
    );
    expect(attribute('x.ts', t).category).toBe('task');
  });

  it('maps cwd-relative paths to toplevel-relative', () => {
    expect(toToplevelPath('/repo', '/repo/pkg', 'src/a.ts')).toBe('pkg/src/a.ts');
    expect(toToplevelPath('/repo', '/repo', 'a.ts')).toBe('a.ts');
  });
});
