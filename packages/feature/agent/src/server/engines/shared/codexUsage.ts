/**
 * Codex (OpenAI) usage → the Claude-shaped usage the client's token bar expects.
 *
 * The two vendors disagree on what `input_tokens` means:
 *  - OpenAI/Codex: the WHOLE prompt; `cached_input_tokens` is a subset of it.
 *    Verified on local rollouts: `total_tokens === input_tokens + output_tokens`
 *    on every non-empty record, with cached tokens > 0 throughout.
 *  - Claude: only the uncached remainder; cache reads/writes are reported beside it.
 * The bar sums input + cache read + cache write, so passing Codex's numbers through
 * unchanged counted every cached token twice. Cache writes are treated as a subset
 * too (OpenAI's convention); every local record reports 0 for them, so that part is
 * unverified.
 */
export interface CodexUsageNumbers {
  input: number;
  cached: number;
  cacheWrite: number;
  output: number;
}

export interface ClaudeShapedUsage {
  input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation_input_tokens: number;
  output_tokens: number;
}

/** Null for the all-zero records Codex occasionally writes (aborted requests): they say nothing about size. */
export function codexUsageToClaude({ input, cached, cacheWrite, output }: CodexUsageNumbers): ClaudeShapedUsage | null {
  if (input <= 0 && output <= 0) return null;
  return {
    input_tokens: Math.max(0, input - cached - cacheWrite),
    cache_read_input_tokens: cached,
    cache_creation_input_tokens: cacheWrite,
    output_tokens: output,
  };
}
