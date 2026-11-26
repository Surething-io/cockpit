import { describe, expect, it } from 'vitest';
import { buildMobileUrl, isLoopbackHostname } from './mobileLink';

describe('isLoopbackHostname', () => {
  it('treats loopback names as local', () => {
    for (const host of ['localhost', 'LOCALHOST', 'app.localhost', '127.0.0.1', '127.1.2.3', '[::1]', '::1', '0.0.0.0']) {
      expect(isLoopbackHostname(host)).toBe(true);
    }
  });

  it('treats LAN addresses, tunnels and domains as remote', () => {
    for (const host of ['192.168.1.10', '10.0.0.2', 'cockpit.example.com', 'box.tail1234.ts.net', '127.example.com']) {
      expect(isLoopbackHostname(host)).toBe(false);
    }
  });
});

describe('buildMobileUrl', () => {
  const origin = 'https://cockpit.example.com';

  it('links to the bare mobile route without context or token', () => {
    expect(buildMobileUrl(origin, {})).toBe('https://cockpit.example.com/m');
  });

  it('deep-links into the session and carries the token', () => {
    const url = new URL(buildMobileUrl(origin, { cwd: '/home/me/my app', sessionId: 'abc', token: 't&k' }));
    expect(url.pathname).toBe('/m');
    expect(url.searchParams.get('cwd')).toBe('/home/me/my app');
    expect(url.searchParams.get('sessionId')).toBe('abc');
    expect(url.searchParams.get('token')).toBe('t&k');
  });

  it('drops a cwd without a session, since /m needs both to open a chat', () => {
    expect(buildMobileUrl(origin, { cwd: '/x', token: 'k' })).toBe('https://cockpit.example.com/m?token=k');
  });
});
