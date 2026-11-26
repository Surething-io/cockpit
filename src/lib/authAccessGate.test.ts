import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createAccessGate, type AccessInput } from './auth';

const token = 'test-token';
const valid = { authHeader: `Bearer ${token}` };
const invalid = { authHeader: 'Bearer wrong' };

const remote = (overrides: Partial<AccessInput> = {}): AccessInput => ({
  url: '/',
  remoteAddr: '192.0.2.10',
  cookieHeader: undefined,
  authHeader: undefined,
  forwarded: undefined,
  isWs: false,
  isHttps: true,
  ...overrides,
});

const via = (remoteAddr: string, forwardedFor: string, overrides: Partial<AccessInput> = {}) =>
  remote({ remoteAddr, forwarded: forwardedFor, forwardedFor, ...overrides });

beforeEach(() => {
  vi.stubEnv('COCKPIT_TOKEN', token);
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
});

describe('createAccessGate', () => {
  it('blocks an IP on its fifth failure across HTTP and WebSocket and unblocks it ten minutes later', () => {
    const check = createAccessGate();
    expect(check(remote(invalid)).action).toBe('deny');
    expect(check(remote({ cookieHeader: 'cockpit_token=wrong' })).action).toBe('deny');
    expect(check(remote({ url: '/?token=wrong' })).action).toBe('deny');
    expect(check(remote({ ...invalid, isWs: true })).action).toBe('deny');
    expect(check(remote({ ...invalid, isWs: true }))).toEqual({ action: 'blocked', retryAfterSeconds: 600 });
    expect(check(remote({ ...valid, remoteAddr: '192.0.2.11' })).action).toBe('pass');
    expect(check(remote(valid))).toEqual({ action: 'blocked', retryAfterSeconds: 600 });

    vi.advanceTimersByTime(599_000);
    expect(check(remote(invalid))).toEqual({ action: 'blocked', retryAfterSeconds: 1 });
    vi.advanceTimersByTime(1_000);
    expect(check(remote(invalid)).action).toBe('deny');
    expect(check(remote(valid)).action).toBe('pass');
  });

  it('resets the streak on valid authentication and ignores requests without a token', () => {
    const check = createAccessGate();
    for (let i = 0; i < 4; i++) expect(check(remote(invalid)).action).toBe('deny');
    expect(check(remote(valid)).action).toBe('pass');
    for (let i = 0; i < 8; i++) expect(check(remote()).action).toBe('deny');
    for (let i = 0; i < 4; i++) expect(check(remote(invalid)).action).toBe('deny');
    expect(check(remote()).action).toBe('deny');
    expect(check(remote(invalid)).action).toBe('blocked');
  });

  it('keeps the HTTP query login, cookie login and WebSocket upgrade behavior', () => {
    const check = createAccessGate();
    expect(check(remote({ url: `/m?token=${token}&view=chat` }))).toMatchObject({
      action: 'redirect',
      location: '/m?view=chat',
      setCookie: expect.stringContaining('cockpit_token=test-token'),
    });
    expect(check(remote({ cookieHeader: 'cockpit_token=test-token' })).action).toBe('pass');
    expect(check(remote({ url: `/?token=${token}`, isWs: true })).action).toBe('pass');
  });

  it('uses the socket IP for direct clients and ignores their claimed forwarded IP', () => {
    const check = createAccessGate('10.0.0.0/24');
    for (let i = 0; i < 5; i++) {
      check(via('192.0.2.10', `198.51.100.${i + 1}, 10.0.0.5`, invalid));
    }
    expect(check(remote(valid)).action).toBe('blocked');
    expect(check(remote({ ...valid, remoteAddr: '198.51.100.1' })).action).toBe('pass');
  });

  it('automatically uses the last address from a loopback proxy and normalizes IPv4-mapped addresses', () => {
    const check = createAccessGate();
    for (let i = 0; i < 5; i++) {
      check(via('127.0.0.1', `198.51.100.${i + 1}, ::ffff:192.0.2.10`, invalid));
    }
    expect(check(via('127.0.0.1', '192.0.2.10', valid)).action).toBe('blocked');
    expect(check(via('127.0.0.1', '198.51.100.1', valid)).action).toBe('pass');
    expect(check(remote({ remoteAddr: '127.0.0.1', ...invalid })).action).toBe('pass');
  });

  it('keeps authentication active when the loopback proxy supplies no valid last address', () => {
    const check = createAccessGate();
    const proxy = { remoteAddr: '127.0.0.1', forwarded: '192.0.2.10' };
    for (const forwardedFor of [undefined, '192.0.2.10, invalid']) {
      for (let i = 0; i < 6; i++) {
        expect(check(remote({ ...proxy, ...invalid, forwardedFor })).action).toBe('deny');
      }
    }
    expect(check(remote({ ...proxy, ...valid, forwardedFor: '192.0.2.10' })).action).toBe('pass');
  });

  it('walks through configured IPv4 and IPv6 proxies to a canonical visitor IP', () => {
    const check = createAccessGate('10.0.0.5, 2001:db8:100::/48');
    for (let i = 0; i < 5; i++) {
      check(via('::ffff:a00:5', `198.51.100.${i + 1}, 2001:0DB8:0000:0:0:0:0:42, 2001:db8:100::1`, invalid));
    }
    expect(check(via('127.0.0.1', '2001:db8::42, 10.0.0.5', valid)).action).toBe('blocked');
    expect(check(via('10.0.0.5', '2001:db8::43, 2001:db8:100::1', valid)).action).toBe('pass');
    expect(check(remote({ remoteAddr: '198.51.100.1', ...valid })).action).toBe('pass');
  });

  it('stops at an unconfigured intermediate hop and treats forwarded loopback as a client address', () => {
    const check = createAccessGate('10.0.0.0/24');
    for (let i = 0; i < 5; i++) {
      check(via('10.0.0.5', `198.51.100.${i + 1}, 10.0.1.9, 10.0.0.20`, invalid));
      check(via('10.0.0.5', `198.51.100.${i + 1}, 127.0.0.1`, invalid));
    }
    expect(check(via('10.0.0.5', '10.0.1.9', valid)).action).toBe('blocked');
    expect(check(via('10.0.0.5', '127.0.0.1', valid)).action).toBe('blocked');
    expect(check(via('10.0.0.5', '198.51.100.1', valid)).action).toBe('pass');
  });

  it('does not attribute malformed or proxy-only chains to a visitor', () => {
    const check = createAccessGate('10.0.0.0/24');
    for (let i = 0; i < 5; i++) {
      expect(check(via('10.0.0.5', '192.0.2.10, invalid, 10.0.0.20', invalid)).action).toBe('deny');
      expect(check(via('10.0.0.5', '10.0.0.20', invalid)).action).toBe('deny');
    }
    expect(check(via('10.0.0.5', '192.0.2.10', valid)).action).toBe('pass');
  });

  it.each(['proxy.example', '10.0.0.0/', '10.0.0.0/33', '2001:db8::/129', '10.0.0.0/24/1'])(
    'rejects an invalid trusted proxy entry %s',
    (entry) => expect(() => createAccessGate(`10.0.0.5,${entry}`)).toThrow('Invalid COCKPIT_TRUSTED_PROXIES'),
  );

  it('handles malformed cookies and still accepts a valid bearer token', () => {
    const check = createAccessGate();
    expect(check(remote({ cookieHeader: 'cockpit_token=%' })).action).toBe('deny');
    expect(check(remote({ cookieHeader: 'other=%', ...valid })).action).toBe('pass');
  });
});
