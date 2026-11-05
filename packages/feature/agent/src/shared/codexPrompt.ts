export const CODEX_IMAGE_ONLY_TEXT = '[Image]';

/** Recognize harness envelopes without discarding ordinary Markdown or XML input. */
export function codexPromptText(text: string, images = 0): string | null {
  const injected = /^# AGENTS\.md instructions(?:\s|$)/.test(text)
    || /^<(?:environment_context|turn_aborted|user_instructions)(?:\s|>)/.test(text);
  return !images && (!text || injected) ? null : text || CODEX_IMAGE_ONLY_TEXT;
}
