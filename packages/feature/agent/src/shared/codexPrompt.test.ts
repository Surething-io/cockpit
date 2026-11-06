import { describe, expect, it } from 'vitest';
import { projectCodexUserMessage, type CodexInputBlock } from './codexPrompt';

const block = (text: string): CodexInputBlock => ({ type: 'input_text', text });
const plugins = '<recommended_plugins>\n- Example\n</recommended_plugins>';
const notification = '<subagent_notification>\n{"agent_path":"agent-1","status":{"completed":"Report ready\\n\\nFull report"}}\n</subagent_notification>';

describe('Codex input sources', () => {
  it.each(['kinds', 'provenance', 'both'])('filters injected AGENTS.md using %s while preserving the same text from a user', (source) => {
    const text = '# AGENTS.md instructions for /example\n\n<INSTRUCTIONS>\nProject rules\n</INSTRUCTIONS>';
    const human = block(text);
    expect(projectCodexUserMessage({
      content: [block(text), human],
      internal_chat_message_metadata_passthrough: {
        ...(source !== 'provenance' ? { content_item_kinds: ['agents_md.instructions', 'user.text'] } : {}),
        ...(source !== 'kinds' ? { content_item_metadata: [
          { provenance: { type: 'agents_md' } },
          { provenance: { type: 'user' } },
        ] } : {}),
      },
    })).toEqual([{ kind: 'prompt', blocks: [human] }]);
  });

  it('selects human blocks before joining text or extracting images', () => {
    const human = block(plugins);
    const image = { type: 'input_image', image_url: 'data:image/png;base64,AAAA' };
    const projected = projectCodexUserMessage({
      content: [block(plugins), block('<environment_context>context</environment_context>'), human, image, block(notification)],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: ['plugins.recommendations', 'environments.environment_context', 'user.text', 'user.image', 'multi_agent.subagent_notification'],
      },
    });
    expect(projected).toEqual([
      { kind: 'prompt', blocks: [human, image] },
      { kind: 'notice', notice: { summary: 'Report ready', status: 'completed', detail: `Report ready\n\nFull report\n\nRaw notification:\n${notification}` } },
    ]);
  });

  it('honors explicit human provenance even without item kinds', () => {
    const content = [block(notification), block('# AGENTS.md instructions for /example')];
    expect(projectCodexUserMessage({ content, internal_chat_message_metadata_passthrough: {
      content_item_metadata: content.map(() => ({ provenance: { type: 'user' } })),
    } })).toEqual([{ kind: 'prompt', blocks: content }]);
  });

  it('recognizes legacy context per block without losing adjacent human text', () => {
    const human = block('<config>debug</config>');
    const projected = projectCodexUserMessage({ content: [block(plugins), block('<environment_context>context</environment_context>'), human, block(notification)] });
    expect(projected[0]).toEqual({ kind: 'prompt', blocks: [human] });
    expect(projected[1]).toMatchObject({ kind: 'notice', notice: { summary: 'Report ready' } });
  });

  it('does not align partial metadata to different content positions', () => {
    const content = [block('first'), block('second')];
    expect(projectCodexUserMessage({ content, internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['plugins.recommendations'],
      content_item_metadata: [{ provenance: { type: 'tool' } }],
    } })).toEqual([{ kind: 'prompt', blocks: content }]);
  });

  it('preserves ambiguous envelope text when source arrays are incomplete', () => {
    const content = [block('before'), block('<environment_context>User example</environment_context>'), block('after')];
    expect(projectCodexUserMessage({ content, internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['user.text', 'user.text'],
    } })).toEqual([{ kind: 'prompt', blocks: content }]);
  });

  it('uses an aligned source array even when the other source array is incomplete', () => {
    const content = [block(plugins), block('<environment_context>User example</environment_context>')];
    expect(projectCodexUserMessage({ content, internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['plugins.recommendations', 'user.text'],
      content_item_metadata: [{ provenance: { type: 'tool' } }],
    } })).toEqual([{ kind: 'prompt', blocks: [content[1]] }]);
  });

  it.each([undefined, [], ['wrong', 'length']])('uses aligned harness provenance when kinds are unavailable: %s', (kinds) => {
    expect(projectCodexUserMessage({
      content: [block('<environment_context>Injected context</environment_context>')],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: kinds,
        content_item_metadata: [{ provenance: { type: 'harness', hook: false } }],
      },
    })).toEqual([]);
  });

  it('keeps nonhuman reports inspectable when only provenance is available', () => {
    const raw = '<subagent_notification>broken JSON</subagent_notification>';
    expect(projectCodexUserMessage({
      content: [block(raw), block('Unknown harness content')],
      internal_chat_message_metadata_passthrough: {
        content_item_kinds: [],
        content_item_metadata: [{ provenance: { type: 'tool', namespace: 'multi_agent_v1' } }, { provenance: { type: 'harness', hook: false } }],
      },
    })).toEqual([
      { kind: 'notice', notice: { summary: 'Sub-agent notification', detail: raw } },
      { kind: 'meta', detail: 'Unknown harness content' },
    ]);
  });

  it.each([null, 'invalid', []])('keeps ambiguous blocks with unusable source information: %s', (kinds) => {
    const content = [block('<environment_context>User example</environment_context>')];
    expect(projectCodexUserMessage({ content, internal_chat_message_metadata_passthrough: {
      content_item_kinds: kinds,
    } })).toEqual([{ kind: 'prompt', blocks: content }]);
  });

  it('keeps unfamiliar input and incomplete unclassified envelopes', () => {
    const content = [block('<subagent_notification>example</subagent_notification>'), block('<recommended_plugins>example'), block('<new_format>example</new_format>')];
    expect(projectCodexUserMessage({ content })).toEqual([{ kind: 'prompt', blocks: content }]);
  });

  it('preserves malformed tool notifications as notices with their raw detail', () => {
    const raw = '<subagent_notification>broken JSON</subagent_notification>';
    const projected = projectCodexUserMessage({ content: [block(raw)], internal_chat_message_metadata_passthrough: {
      content_item_kinds: ['multi_agent.subagent_notification'],
    } });
    expect(projected).toEqual([{ kind: 'notice', notice: { summary: 'Sub-agent notification', detail: raw } }]);
  });
});
