import { describe, expect, it } from 'vitest';
import { reconcileStatusTabIds, type TabInfo } from './useTabState';

const CWD = '/workspace';
const tabs: TabInfo[] = [
  { id: 'tab-a', cwd: CWD, sessionId: 'session-a', title: 'A' },
  { id: 'tab-b', cwd: CWD, sessionId: 'session-b', title: 'B' },
];

describe('reconcileStatusTabIds', () => {
  it('restores running status for active and background tabs after refresh', () => {
    const sessions = [
      { cwd: CWD, sessionId: 'session-a', status: 'loading' },
      { cwd: CWD, sessionId: 'session-b', status: 'loading' },
    ];

    expect(reconcileStatusTabIds(new Set(), tabs, sessions, CWD, 'loading'))
      .toEqual(new Set(['tab-a', 'tab-b']));
  });

  it('clears running when the server reports a terminal status', () => {
    const sessions = [
      { cwd: CWD, sessionId: 'session-a', status: 'unread' },
      { cwd: CWD, sessionId: 'session-b', status: 'normal' },
    ];

    expect(reconcileStatusTabIds(new Set(['tab-a', 'tab-b']), tabs, sessions, CWD, 'loading'))
      .toEqual(new Set());
    expect(reconcileStatusTabIds(new Set(), tabs, sessions, CWD, 'unread'))
      .toEqual(new Set(['tab-a']));
  });

  it('preserves sessions omitted from a capped snapshot and removes closed tabs', () => {
    const current = new Set(['tab-a', 'closed-tab']);

    expect(reconcileStatusTabIds(current, tabs, [], CWD, 'loading'))
      .toEqual(new Set(['tab-a']));
  });

  it('matches normalized Codex rollout paths to restored session ids', () => {
    const sessionId = '0198abcd-1234-5678-9abc-0123456789ab';
    const codexTabs: TabInfo[] = [
      { id: 'tab-codex', cwd: CWD, sessionId, title: 'Codex', engine: 'codex' },
    ];
    const sessions = [{
      cwd: CWD,
      sessionId: `/tmp/rollout-${sessionId}.jsonl`,
      status: 'loading',
      engine: 'codex',
    }];

    expect(reconcileStatusTabIds(new Set(), codexTabs, sessions, CWD, 'loading'))
      .toEqual(new Set(['tab-codex']));
  });
});
