import type { ToolCallInfo } from '@cockpit/feature-agent';

/** What the Explorer-panel file-changes overlay is currently showing. */
export interface FileDiffRequest {
  /** Identity of the source message — stable while it keeps streaming. */
  messageId: string;
  toolCalls: ToolCallInfo[];
  cwd?: string;
  sessionId?: string;
}

/**
 * Reducer for that overlay.
 *
 * A `live` push comes from a still-streaming message that just appended a tool
 * call. It may only refresh an overlay ALREADY showing that message — never
 * (re)open one the user closed or swapped away from. A user click (live=false)
 * always wins and replaces whatever is there.
 */
export function nextFileDiffRequest(
  prev: FileDiffRequest | null,
  next: FileDiffRequest,
  live: boolean,
): FileDiffRequest | null {
  if (!live) return next;
  if (prev?.messageId !== next.messageId) return prev;
  return { ...prev, toolCalls: next.toolCalls };
}
