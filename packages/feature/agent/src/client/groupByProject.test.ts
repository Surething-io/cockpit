import { describe, expect, it } from 'vitest';
import { groupByProject } from './SessionRowParts';
import { sortSessionsForDisplay } from './sessionOrder';

const row = (cwd: string, id: string, status?: string, lastActive = 0) => ({ cwd, sessionId: id, status, lastActive });

describe('groupByProject', () => {
  it('orders groups by first appearance and keeps row order inside a group', () => {
    const groups = groupByProject([row('/a', '1'), row('/b', '2'), row('/a', '3'), row('/c', '4'), row('/b', '5')]);
    expect(groups.map((g) => g.cwd)).toEqual(['/a', '/b', '/c']);
    expect(groups.map((g) => g.items.map((r) => r.sessionId))).toEqual([['1', '3'], ['2', '5'], ['4']]);
  });

  // The recent-sessions board relies on this: grouping a status-sorted list puts
  // the project holding an unread session first, then one with a running session.
  it('floats the project with the most urgent session to the top of a status-sorted list', () => {
    const sorted = sortSessionsForDisplay([
      row('/recent', 'r', 'normal', 300),
      row('/running', 'g', 'loading', 100),
      row('/unread', 'u', 'unread', 50),
      row('/recent', 'r2', 'normal', 200),
    ]);
    expect(groupByProject(sorted).map((g) => g.cwd)).toEqual(['/unread', '/running', '/recent']);
  });
});
