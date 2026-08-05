import { describe, it, expect } from 'vitest';
import { formatProviderError } from './providerError';

describe('formatProviderError', () => {
  it('keeps the provider sentence and status from an APICallError', () => {
    // The real shape Kimi returns for a model the plan does not cover.
    const error = Object.assign(new Error('Your current subscription does not have access to k3.'), {
      statusCode: 401,
      responseBody: JSON.stringify({
        error: {
          message: 'Your current subscription does not have access to k3.',
          type: 'invalid_authentication_error',
        },
      }),
    });

    const out = formatProviderError(error);
    expect(out).toContain('401');
    expect(out).toContain('does not have access to k3');
    // The SDK already lifted the body text into `.message` — don't say it twice.
    expect(out.match(/does not have access to k3/g)).toHaveLength(1);
  });

  it('recovers the body sentence when .message is a generic status word', () => {
    const error = Object.assign(new Error('Unauthorized'), {
      statusCode: 401,
      responseBody: JSON.stringify({ error: { message: 'Insufficient balance, please top up.' } }),
    });

    expect(formatProviderError(error)).toBe('[HTTP 401] Unauthorized — Insufficient balance, please top up.');
  });

  it('handles plain Errors, strings and junk without going empty', () => {
    expect(formatProviderError(new Error('boom'))).toBe('boom');
    expect(formatProviderError('boom')).toBe('boom');
    expect(formatProviderError(null)).toBe('Unknown error');
    expect(formatProviderError({})).toBe('Request failed');
  });

  it('ignores an HTML error page but keeps short plain text', () => {
    const html = Object.assign(new Error('Bad Gateway'), {
      statusCode: 502,
      responseBody: `<html><body>${'x'.repeat(400)}</body></html>`,
    });
    expect(formatProviderError(html)).toBe('[HTTP 502] Bad Gateway');

    const plain = Object.assign(new Error(''), { statusCode: 429, responseBody: 'rate limit exceeded' });
    expect(formatProviderError(plain)).toBe('[HTTP 429] rate limit exceeded');
  });
});
