import { describe, it, expect } from 'vitest';
import { toQuotaPayload, type RawQuota } from './usage';

// Captured verbatim from GET /api/monitor/usage/quota/limit on a Coding Plan (lite)
// account, one chat call after the first sample. Keeping the real bytes matters: the
// field names in this response do not mean what they say.
const LIVE: RawQuota = {
  code: 200,
  msg: '操作成功',
  success: true,
  data: {
    level: 'lite',
    limits: [
      { type: 'CREDIT_LIMIT', unit: 3, number: 5, usage: 2000, currentValue: 0, remaining: 1999, percentage: 1, nextResetTime: 1785939405971 },
      { type: 'CREDIT_LIMIT', unit: 6, number: 1, usage: 10000, currentValue: 0, remaining: 9999, percentage: 1, nextResetTime: 1786526128998 },
    ],
  },
};

describe('GLM quota mapping', () => {
  it('reads `usage` as the CAP and `remaining` as what is left — not `currentValue`', () => {
    const { windows } = toQuotaPayload(LIVE);
    expect(windows[0].limit).toBe(2000);
    expect(windows[0].remaining).toBe(1999);
    // currentValue stayed 0 across a real request; deriving remaining from it would report
    // a full allowance forever.
    expect(windows[0].remaining).not.toBe(LIVE.data!.limits![0].currentValue);
  });

  it('decodes the opaque time units: 3 → hours, 6 → weeks', () => {
    const { windows } = toQuotaPayload(LIVE);
    expect(windows.map((w) => w.label)).toEqual(['5h', '1w']);
  });

  it('labels an unknown unit neutrally instead of guessing a duration', () => {
    const { windows } = toQuotaPayload({
      code: 200,
      success: true,
      data: { level: 'lite', limits: [{ unit: 99, number: 3, usage: 1, remaining: 1 }] },
    });
    expect(windows[0].label).toBe('quota');
  });

  it('converts epoch ms to ISO, and tolerates a rolling window that has not started', () => {
    const { windows } = toQuotaPayload(LIVE);
    expect(windows[0].resetTime).toBe(new Date(1785939405971).toISOString());
    const noReset = toQuotaPayload({
      code: 200,
      success: true,
      data: { limits: [{ unit: 3, number: 5, usage: 2000, remaining: 2000 }] },
    });
    expect(noReset.windows[0].resetTime).toBeNull();
  });

  it('treats a plan-less account as an error — it arrives as HTTP 200', () => {
    // A plain pay-as-you-go key gets this. Chat still works; only quota is unavailable.
    expect(() =>
      toQuotaPayload({ code: 500, msg: '当前用户不存在coding plan', success: false })
    ).toThrow('当前用户不存在coding plan');
  });

  it('surfaces the tier, since the same numbers mean different things per plan', () => {
    expect(toQuotaPayload(LIVE).tier).toBe('lite');
  });
});
