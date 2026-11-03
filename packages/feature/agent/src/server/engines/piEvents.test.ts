// Usage is cumulative for one Cockpit run, with each finalized response counted once.
import { describe, expect, it } from 'vitest';
import type { AssistantMessage } from '@earendil-works/pi-ai';
import { createPiRunUsage, piTool, piBranchMessages, piRunEvents } from './piEvents';

function response(output: number, stopReason: AssistantMessage['stopReason'] = 'stop'): AssistantMessage {
  return {
    role: 'assistant', content: [{ type: 'text', text: 'same answer' }],
    api: 'openai-completions', provider: 'ollama', model: 'test', stopReason, timestamp: 1,
    usage: { input: 10, output, cacheRead: 2, cacheWrite: 3, totalTokens: 15 + output,
      cost: { input: 0.1, output: 0.2, cacheRead: 0, cacheWrite: 0, total: 0.3 } },
  };
}

describe('Pi run usage', () => {
  it('counts tool steps and retry responses while deduplicating the same completion', () => {
    const usage = createPiRunUsage();
    const first = response(7);
    const firstUpdate = usage.record(first);
    expect(usage.record(first)).toBeUndefined();
    usage.record(response(3, 'error'));
    expect(usage.record(response(7))).toMatchObject({ output_tokens: 17 });
    expect(firstUpdate).toMatchObject({ output_tokens: 7 });
    expect(usage.snapshot()).toEqual({ input_tokens: 30, output_tokens: 17, cache_read_input_tokens: 6, cache_creation_input_tokens: 9 });
    expect(usage.cost()).toBeCloseTo(0.9);
  });

  it('starts each run at zero even when another run already counted the same response', () => {
    const message = response(7);
    const previous = createPiRunUsage();
    previous.record(message);
    const next = createPiRunUsage();
    expect(next.snapshot().output_tokens).toBe(0);
    expect(next.record(message)).toMatchObject({ output_tokens: 7 });
  });
});

it('projects the same paths that native Pi tools actually use', async () => {
  const { createWriteTool } = await import('@earendil-works/pi-coding-agent');
  const { pathToFileURL } = await import('node:url');
  const { join } = await import('node:path');
  const cwd = process.cwd();
  let executedPath = '';
  const tool = createWriteTool(cwd, { operations: {
    writeFile: async (path) => { executedPath = path; }, mkdir: async () => {},
  } });
  for (const path of ['@./probe.txt', '~/probe.txt', '~', './space\u202Fname.txt',
    pathToFileURL(join(cwd, 'file with spaces.txt')).href, './plain.txt', join(cwd, 'absolute.txt')]) {
    await tool.execute('probe', { path, content: 'test' });
    expect(piTool('write', { path }, cwd).input.file_path).toBe(executedPath);
  }
});

it('renders truncation notices using the latest context edit rather than an older exclusion', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.inMemory(process.cwd());
  const id = manager.appendMessage(response(1, 'length'));
  manager.appendContextEdit(id, null);
  expect(JSON.stringify(piBranchMessages(manager.getBranch()))).toContain('excluded this response');
  manager.appendContextEdit(id, { content: [{ type: 'text', text: 'restored partial answer' }] });
  const rows = JSON.stringify(piBranchMessages(manager.getBranch()));
  expect(rows).toContain('stopReason=length');
  expect(rows).not.toContain('excluded this response');
});


it('projects execution notices and stops as metadata in history and live events', async () => {
  const { SessionManager } = await import('@earendil-works/pi-coding-agent');
  const manager = SessionManager.inMemory(process.cwd());
  manager.appendCustomMessageEntry('cockpit.execution-notice', 'Execution notice: repeated query', true);
  manager.appendCustomMessageEntry('cockpit.execution-stop', 'Execution stopped: no_progress', true);
  manager.appendCustomEntry('cockpit.execution-stop', { text: 'Execution stopped: no_progress' });
  const entries = manager.getBranch();
  const rows = piBranchMessages(entries);
  expect(rows).toHaveLength(3);
  expect(rows.every((row) => row.isMeta)).toBe(true);
  for (const entry of entries) {
    const events = piRunEvents({ type: 'entry_appended', entry });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ type: 'user', isMeta: true });
  }
});
