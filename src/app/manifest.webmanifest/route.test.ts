import { existsSync } from 'fs';
import { join } from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { GET } from './route';

/**
 * The manifest's icon set tells the installs apart: a PWA from localhost (laptop
 * badge), one from a remote server (globe badge), and the desktop app (plain).
 * COCKPIT_ENV is pinned per test: a dev cockpit that spawned this run leaks
 * COCKPIT_ENV=dev, which would put every case on the dev icons.
 */
let saved: string | undefined;

beforeEach(() => {
  saved = process.env.COCKPIT_ENV;
  delete process.env.COCKPIT_ENV;
});

afterEach(() => {
  if (saved === undefined) delete process.env.COCKPIT_ENV;
  else process.env.COCKPIT_ENV = saved;
});

const iconDirFor = async (host: string | null) => {
  const headers = host === null ? undefined : { host };
  const res = await GET(new Request('http://x/manifest.webmanifest', { headers }));
  const body = (await res.json()) as { icons: { src: string }[] };
  return body.icons[0].src.replace(/\/icon-\d+x\d+\.png$/, '');
};

describe('GET /manifest.webmanifest icons', () => {
  it.each(['localhost:3457', '127.0.0.1:3457', '[::1]:3457', 'cockpit.localhost'])('uses the local badge for loopback host %s', async (host) => {
    expect(await iconDirFor(host)).toBe('/icons/local');
  });

  it.each(['devbox.tail1234.ts.net', '192.168.1.20:3457', 'cockpit.example.com', '[fd7a:115c::1]:3457'])('badges the icons for remote host %s', async (host) => {
    expect(await iconDirFor(host)).toBe('/icons/remote');
  });

  it('treats a request without a Host header as local', async () => {
    expect(await iconDirFor(null)).toBe('/icons/local');
  });

  it('keeps the dev icons on a dev instance, remote or not', async () => {
    process.env.COCKPIT_ENV = 'dev';
    expect(await iconDirFor('localhost:3456')).toBe('/icons/dev');
    expect(await iconDirFor('devbox.tail1234.ts.net')).toBe('/icons/dev');
  });

  it.each(['localhost:3457', 'devbox.example.com'])('points at icon files that exist for %s', async (host) => {
    const res = await GET(new Request('http://x/manifest.webmanifest', { headers: { host } }));
    const body = (await res.json()) as { icons: { src: string }[] };
    for (const icon of body.icons) expect(existsSync(join(process.cwd(), 'public', icon.src))).toBe(true);
  });
});
