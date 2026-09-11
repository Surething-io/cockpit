import { describe, expect, it } from 'vitest';
import { buildNoticeMessage } from './systemNotice';

describe('buildNoticeMessage', () => {
  const ev = {
    type: 'system',
    subtype: 'notice',
    notice: 'codex_resume_failed',
    previous_session_id: 'old-id',
    session_id: 'new-id',
    error: 'thread-store conflict: thread old-id already has an active writer',
  };

  it('renders the muted system row shape MessageBubble expects', () => {
    const row = buildNoticeMessage(ev, 'n1');
    expect(row).toMatchObject({ id: 'n1', role: 'system', systemEvent: { kind: 'meta' } });
    expect(row?.content).toBeTruthy();
  });

  /**
   * The one-liner has to stay short enough for the bar; everything that makes
   * the notice actionable — which session was abandoned, which one replaced it,
   * and what the engine actually said — belongs in the detail modal.
   */
  it('keeps both ids and the raw engine reason in the detail body', () => {
    const detail = buildNoticeMessage(ev, 'n1')?.systemEvent?.detail ?? '';
    expect(detail).toContain('old-id');
    expect(detail).toContain('new-id');
    expect(detail).toContain('already has an active writer');
  });

  it('tolerates a notice that carries no ids', () => {
    const row = buildNoticeMessage({ notice: 'codex_resume_failed' }, 'n1');
    expect(row?.systemEvent?.detail).toBe(row?.content);
  });

  /** A newer server talking to an older client must say nothing, not say blank. */
  it('ignores notice kinds it does not know', () => {
    expect(buildNoticeMessage({ notice: 'from_the_future' }, 'n1')).toBeNull();
    expect(buildNoticeMessage({ type: 'system', subtype: 'notice' }, 'n1')).toBeNull();
  });
});
