export const CODEX_IMAGE_ONLY_TEXT = '[Image]';

export interface CodexInputBlock {
  type?: string;
  text?: string;
  image_url?: string;
}

export interface CodexUserMessage {
  content?: CodexInputBlock[];
  internal_chat_message_metadata_passthrough?: unknown;
}

export interface CodexSubagentNotice {
  summary: string;
  detail: string;
  status?: string;
}

export type CodexUserEvent =
  | { kind: 'prompt'; blocks: CodexInputBlock[] }
  | { kind: 'notice'; notice: CodexSubagentNotice }
  | { kind: 'meta'; detail: string };

const CONTEXT_KINDS = new Set([
  'agents_md.instructions',
  'plugins.recommendations',
  'environments.environment_context',
  'generic.turn_aborted',
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notificationBody(text: string): string | undefined {
  return text.trim().match(/^<subagent_notification>\s*([\s\S]*?)\s*<\/subagent_notification>$/)?.[1];
}

function isContextText(text: string): boolean {
  return /^# AGENTS\.md instructions(?:\s|$)/.test(text)
    || /^<(?:environment_context|turn_aborted|user_instructions)(?:\s|>)/.test(text)
    || /^<recommended_plugins>[\s\S]*<\/recommended_plugins>$/.test(text.trim());
}

function notificationData(text: string): Record<string, unknown> | undefined {
  const body = notificationBody(text);
  if (body === undefined) return undefined;
  try {
    const data: unknown = JSON.parse(body);
    return isRecord(data) && typeof data.agent_path === 'string' && isRecord(data.status) ? data : undefined;
  } catch {
    return undefined;
  }
}

function subagentNotice(raw: string, data = notificationData(raw)): CodexSubagentNotice {
  const state = data && isRecord(data.status) ? Object.entries(data.status)[0] : undefined;
  const text = state && typeof state[1] === 'string' ? state[1].trim() : '';
  const status = state?.[0] === 'errored' ? 'failed' : state?.[0] === 'shutdown' ? 'stopped' : state?.[0];
  return {
    summary: text.split('\n').find((line) => line.trim()) || 'Sub-agent notification',
    detail: text ? `${text}\n\nRaw notification:\n${raw}` : raw,
    ...(status ? { status } : {}),
  };
}

/** Classify blocks before text/image extraction; metadata describes the original block positions. */
export function projectCodexUserMessage(payload: CodexUserMessage): CodexUserEvent[] {
  const content = payload.content || [];
  const meta = isRecord(payload.internal_chat_message_metadata_passthrough)
    ? payload.internal_chat_message_metadata_passthrough : undefined;
  const kinds = Array.isArray(meta?.content_item_kinds) && meta.content_item_kinds.length === content.length
    ? meta.content_item_kinds : undefined;
  const items = Array.isArray(meta?.content_item_metadata) && meta.content_item_metadata.length === content.length
    ? meta.content_item_metadata : undefined;
  const hasSources = meta
    ? 'content_item_kinds' in meta || 'content_item_metadata' in meta
    : payload.internal_chat_message_metadata_passthrough != null;
  const events: CodexUserEvent[] = [];
  let prompt: Extract<CodexUserEvent, { kind: 'prompt' }> | undefined;
  const appendPrompt = (block: CodexInputBlock): void => {
    // A raw message has one user bubble, anchored at its first human block.
    // Later human blocks join it without reordering the surrounding notices.
    if (!prompt) {
      prompt = { kind: 'prompt', blocks: [] };
      events.push(prompt);
    }
    prompt.blocks.push(block);
  };

  content.forEach((block, index) => {
    if (!isRecord(block)) return;
    const rawKind: unknown = kinds?.[index];
    const kind = typeof rawKind === 'string' ? rawKind : undefined;
    const item: unknown = items?.[index];
    const provenance = isRecord(item) && isRecord(item.provenance) ? item.provenance : undefined;
    // Explicit human input wins over text that merely looks like a harness envelope.
    if (kind?.startsWith('user.') || provenance?.type === 'user') {
      appendPrompt(block);
      return;
    }
    const text = typeof block.text === 'string' ? block.text : '';
    if (kind === 'multi_agent.subagent_notification') {
      events.push({ kind: 'notice', notice: subagentNotice(text) });
      return;
    }
    if ((kind && CONTEXT_KINDS.has(kind)) || provenance?.type === 'agents_md') return;

    // The other aligned source array can remain reliable when kinds are absent.
    // Known context is hidden; other nonhuman content remains inspectable, never a user prompt.
    if (provenance?.type === 'harness' || provenance?.type === 'tool') {
      if (/^<subagent_notification(?:\s|>)/.test(text.trim())) {
        events.push({ kind: 'notice', notice: subagentNotice(text) });
      } else if (!isContextText(text)) {
        events.push({ kind: 'meta', detail: text.trim() || JSON.stringify(block) });
      }
      return;
    }

    // Present but unusable/unknown sources are ambiguous, not legacy input.
    // Do not let a text heuristic delete a user example after alignment failed.
    if (hasSources) {
      appendPrompt(block);
      return;
    }

    // Older rollouts lack provenance. Recognize complete notification envelopes,
    // retaining unfamiliar XML and malformed unclassified input as user content.
    const data = notificationData(text);
    if (data) {
      events.push({ kind: 'notice', notice: subagentNotice(text, data) });
      return;
    }
    if (isContextText(text)) return;
    appendPrompt(block);
  });

  return events;
}

/** Format already-classified human input; never reinterpret a user's pasted text. */
export function codexPromptText(text: string, images = 0): string | null {
  return text || (images ? CODEX_IMAGE_ONLY_TEXT : null);
}
