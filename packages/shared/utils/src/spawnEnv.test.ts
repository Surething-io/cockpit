import { describe, it, expect } from 'vitest';
import { sanitizedSpawnEnv, NEXT_INJECTED_ENV_KEYS } from './spawnEnv';

const BASE = {
  PATH: '/usr/bin',
  HOME: '/home/u',
  ANTHROPIC_API_KEY: 'sk-test',
  NODE_ENV: 'production',
  NEXT_DEPLOYMENT_ID: '',
  TURBOPACK: 'auto',
} satisfies NodeJS.ProcessEnv;

describe('sanitizedSpawnEnv', () => {
  it('removes every variable Next injects into the server process', () => {
    const env = sanitizedSpawnEnv({}, BASE);
    for (const key of NEXT_INJECTED_ENV_KEYS) {
      expect(key in env, `${key} must not reach the child`).toBe(false);
    }
  });

  it('deletes rather than blanks — an empty string is not good enough', () => {
    // NEXT_DEPLOYMENT_ID arrives as "" and would still read as "set" downstream.
    const env = sanitizedSpawnEnv({}, BASE);
    expect(env.NEXT_DEPLOYMENT_ID).toBeUndefined();
    expect(Object.keys(env)).not.toContain('NEXT_DEPLOYMENT_ID');
  });

  it('passes everything else through untouched', () => {
    expect(sanitizedSpawnEnv({}, BASE)).toEqual({
      PATH: '/usr/bin',
      HOME: '/home/u',
      ANTHROPIC_API_KEY: 'sk-test',
    });
  });

  it('applies overrides after stripping, so a caller can set a stripped key back', () => {
    expect(sanitizedSpawnEnv({ NODE_ENV: 'test' }, BASE).NODE_ENV).toBe('test');
  });

  it('treats an undefined override as a delete (empty string would break the SDK)', () => {
    const env = sanitizedSpawnEnv({ ANTHROPIC_AUTH_TOKEN: undefined }, {
      ...BASE,
      ANTHROPIC_AUTH_TOKEN: 'stale',
    });
    expect(Object.keys(env)).not.toContain('ANTHROPIC_AUTH_TOKEN');
  });

  it('never returns undefined values — the SDK types env as Record<string, string>', () => {
    const env = sanitizedSpawnEnv({}, { ...BASE, SOMETHING_UNSET: undefined });
    expect(Object.values(env).every((v) => typeof v === 'string')).toBe(true);
  });

  it('does not mutate the base env it was handed', () => {
    const base = { ...BASE };
    sanitizedSpawnEnv({ FORCE_COLOR: '0' }, base);
    expect(base).toEqual(BASE);
  });
});
