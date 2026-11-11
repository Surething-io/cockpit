import { describe, expect, it } from 'vitest';
import { codexUsageToClaude } from './codexUsage';

describe('codexUsageToClaude', () => {
  it('moves cached tokens out of input so the bar\'s input + cache sum equals the prompt', () => {
    const usage = codexUsageToClaude({ input: 30531, cached: 13184, cacheWrite: 0, output: 107 });
    expect(usage).toEqual({ input_tokens: 17347, cache_read_input_tokens: 13184, cache_creation_input_tokens: 0, output_tokens: 107 });
    expect(usage!.input_tokens + usage!.cache_read_input_tokens + usage!.cache_creation_input_tokens).toBe(30531);
  });

  it('drops the all-zero records Codex writes for aborted requests', () => {
    expect(codexUsageToClaude({ input: 0, cached: 0, cacheWrite: 0, output: 0 })).toBeNull();
  });

  it('never goes negative on inconsistent counters', () => {
    expect(codexUsageToClaude({ input: 10, cached: 20, cacheWrite: 0, output: 1 })?.input_tokens).toBe(0);
  });
});
