/**
 * Constraint: OriginGateProperties (relationship / permission, L2 — property-based).
 *
 * checkOriginGate (src/lib/auth.ts) is the boundary for every request the
 * server accepts, including the shell channels (/ws/bash, POST /api/bash) and
 * the credential endpoints. Its rules are checked here over generated inputs —
 * random hosts, ports, origins, peer addresses, methods and forwarding headers —
 * instead of a handful of examples:
 *
 *   P1  a state-changing request (non-safe method or WebSocket upgrade) whose
 *       Origin names a different host:port than Host is denied — from any peer,
 *       and also for the same hostname on another port (another local server)
 *   P2  a loopback peer whose Host is not an allowed name is denied, whatever
 *       the method, Origin or forwarding header (token mode off) — DNS rebinding
 *   P3  a state-changing request with an unparseable or opaque Origin is denied
 *   P4  same-origin requests and requests without Origin (CLI, curl) pass
 *
 * Why: this function is the whole boundary of a local shell, and the docs used
 * to point at a different check. Example tests pin what someone thought of;
 * these pin the rule.
 */
import fc from 'fast-check';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkOriginGate, type OriginGateInput } from '../src/lib/auth';

const NUM_RUNS = 500;

beforeEach(() => {
  delete process.env.COCKPIT_ALLOWED_HOSTS;
  delete process.env.COCKPIT_TOKEN;
  delete process.env.COCKPIT_HOST;
});
afterEach(() => {
  delete process.env.COCKPIT_ALLOWED_HOSTS;
  delete process.env.COCKPIT_TOKEN;
  delete process.env.COCKPIT_HOST;
});

// ── Generators ────────────────────────────────────────────────────────────────

const port = fc.integer({ min: 1, max: 65535 });
const octet = fc.integer({ min: 0, max: 255 });

/** Peer addresses the OS reports for a loopback connection, IPv4 / IPv6 / v4-mapped. */
const loopbackAddr = fc.oneof(
  fc.tuple(octet, octet, octet).map(([a, b, c]) => `127.${a}.${b}.${c}`),
  fc.constant('::1'),
  fc.tuple(octet, octet, octet).map(([a, b, c]) => `::ffff:127.${a}.${b}.${c}`),
);
const lanAddr = fc.constantFrom('192.168.1.5', '10.0.0.43', '::ffff:192.168.1.5', 'fe80::1');
const anyAddr = fc.oneof(loopbackAddr, lanAddr);

/** Host header values a browser on this machine legitimately sends. */
const allowedHost = fc
  .tuple(fc.constantFrom('localhost', '127.0.0.1', '[::1]', 'app.localhost', 'LOCALHOST'), port)
  .map(([h, p]) => `${h}:${p}`);

/** Hostnames an attacker controls (DNS rebinding targets). */
const foreignHostname = fc
  .domain()
  .filter((d) => !/(^|\.)localhost$/i.test(d) && !/^127\./.test(d));

const unsafeRequest = fc.oneof(
  fc.constantFrom('POST', 'PUT', 'PATCH', 'DELETE', 'post').map((method) => ({ method, isWs: false })),
  fc.constant({ method: 'GET', isWs: true }),
);
const anyRequest = fc.oneof(
  unsafeRequest,
  fc.constantFrom('GET', 'HEAD', 'OPTIONS').map((method) => ({ method, isWs: false })),
);
const forwarded = fc.option(fc.constantFrom('203.0.113.9', 'for=1.2.3.4', '127.0.0.1'), { nil: undefined });
const scheme = fc.constantFrom('http', 'https');

/** An Origin whose host:port differs from `host` — another site, or this hostname on another port. */
const crossOriginFor = (host: string) => {
  const sep = host.lastIndexOf(':');
  const hostname = host.slice(0, sep);
  const hostPort = Number(host.slice(sep + 1));
  return fc
    .oneof(
      fc.tuple(scheme, foreignHostname, port).map(([s, h, p]) => `${s}://${h}:${p}`),
      fc.tuple(scheme, port.filter((p) => p !== hostPort)).map(([s, p]) => `${s}://${hostname}:${p}`),
    )
    .filter((o) => {
      try {
        return new URL(o).host.toLowerCase() !== host.toLowerCase();
      } catch {
        return false;
      }
    });
};

const decide = (input: OriginGateInput) => checkOriginGate(input).action;

// ── Properties ────────────────────────────────────────────────────────────────

describe('OriginGateProperties', () => {
  it('P1: a cross-origin state-changing request is denied, from any peer', () => {
    fc.assert(
      fc.property(
        allowedHost.chain((host) => fc.tuple(fc.constant(host), crossOriginFor(host))),
        unsafeRequest,
        anyAddr,
        forwarded,
        ([host, origin], req, remoteAddr, fwd) =>
          decide({ ...req, host, origin, remoteAddr, forwarded: fwd }) === 'deny',
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('P2: a loopback peer naming a foreign Host is denied, whatever else it sends', () => {
    fc.assert(
      fc.property(
        fc.tuple(foreignHostname, port).map(([h, p]) => `${h}:${p}`),
        anyRequest,
        loopbackAddr,
        fc.option(fc.webUrl(), { nil: undefined }),
        forwarded,
        (host, req, remoteAddr, origin, fwd) =>
          decide({ ...req, host, origin, remoteAddr, forwarded: fwd }) === 'deny',
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('P3: an opaque or unparseable Origin on a state-changing request is denied', () => {
    fc.assert(
      fc.property(
        allowedHost,
        unsafeRequest,
        anyAddr,
        fc.oneof(fc.constant('null'), fc.constant(''), fc.string().filter((s) => { try { new URL(s); return false; } catch { return true; } })),
        (host, req, remoteAddr, origin) => decide({ ...req, host, origin, remoteAddr, forwarded: undefined }) === 'deny',
      ),
      { numRuns: NUM_RUNS },
    );
  });

  it('P4: same-origin requests and requests without Origin pass', () => {
    fc.assert(
      fc.property(allowedHost, anyRequest, loopbackAddr, scheme, fc.boolean(), (host, req, remoteAddr, s, withOrigin) => {
        const origin = withOrigin ? `${s}://${host}` : undefined;
        return decide({ ...req, host, origin, remoteAddr, forwarded: undefined }) === 'pass';
      }),
      { numRuns: NUM_RUNS },
    );
  });

  it('P2 holds with token mode on unless the request is forwarded (then the token gate decides)', () => {
    process.env.COCKPIT_TOKEN = 'secret';
    fc.assert(
      fc.property(
        fc.tuple(foreignHostname, port).map(([h, p]) => `${h}:${p}`),
        anyRequest,
        loopbackAddr,
        (host, req, remoteAddr) => decide({ ...req, host, origin: undefined, remoteAddr, forwarded: undefined }) === 'deny',
      ),
      { numRuns: NUM_RUNS },
    );
  });
});

it('generators produce v4-mapped loopback peers (the case example tests missed)', () => {
  expect(fc.sample(loopbackAddr, 300).some((a) => a.startsWith('::ffff:127.') && a !== '::ffff:127.0.0.1')).toBe(true);
});
