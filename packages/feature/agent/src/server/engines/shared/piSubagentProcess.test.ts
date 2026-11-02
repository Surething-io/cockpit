// Exercise the IPC boundary with real processes, without provider calls.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { pathToFileURL } from 'node:url';
import { beforeAll, afterAll, expect, it } from 'vitest';
import { startPiChild } from './piSubagentProcess';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'pi-child-ipc-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
async function fixture(name: string, source: string) {
  const path = join(dir, `${name}.mjs`);
  await writeFile(path, source);
  return path;
}
it.each([51199, 51200, 51201])('reports local output completeness at %s characters', async (length) => {
  const path = await fixture(`output-${length}`, `console.log(JSON.stringify({ type: 'message_end', message: { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: 'x'.repeat(${length}) }] } }));`);
  const child = startPiChild(path, [], dir, process.env, () => {});
  const result = await child.closed;
  expect(child.isClosed()).toBe(true);
  expect(result.output).toHaveLength(Math.min(length, 51200));
  expect(result.truncated).toBe(length > 51200);
  if (length > 51200) expect(result.error).toContain('host output limit');
  else expect(result.error).toBeUndefined();
});
it.each([
  ['malformed', 'console.log("not-json")', 'Invalid Pi JSON event'],
  ['missing', '', 'stopReason=missing'],
  ['exit', 'process.exitCode = 7', 'exitCode=7'],
  ['oversized', 'console.log("x".repeat(2 * 1024 * 1024 + 1))', 'exceeded 2 MiB'],
])('reports protocol/process failure: %s', async (name, source, error) => {
  const path = await fixture(name, source);
  const child = startPiChild(path, [], dir, process.env, () => {});
  expect((await child.closed).error).toContain(error);
  expect(child.isClosed()).toBe(true);
});
it('waits for actual exit when a process ignores TERM and requires KILL', async () => {
  const path = await fixture('ignore-term', `process.on('SIGTERM', () => {}); setInterval(() => {}, 1000); console.log(JSON.stringify({ type: 'tool_execution_start', toolName: 'ready' }));`);
  let ready!: () => void;
  const started = new Promise<void>((resolve) => { ready = resolve; });
  const child = startPiChild(path, [], dir, process.env, ready);
  try {
    await started;
    child.terminate();
    expect(child.isClosed()).toBe(false);
    child.kill();
    expect((await child.closed).error).toContain('signal=SIGKILL');
    expect(child.isClosed()).toBe(true);
  } finally { child.kill(); await child.closed; }
});

it.each(['oversized', 'malformed', 'exit'])('retains the current streamed answer on %s instead of returning a previous answer', async (failure) => {
  const events = [
    { type: 'message_end', message: { role: 'assistant', stopReason: 'toolUse', content: [{ type: 'text', text: 'Earlier answer' }] } },
    { type: 'message_start', message: { role: 'assistant' } },
    { type: 'message_update', assistantMessageEvent: { type: 'text_delta', delta: 'Visible partial answer' } },
  ];
  const tail = failure === 'oversized' ? 'console.log("x".repeat(2100000))' : failure === 'malformed' ? 'console.log("invalid-json")' : 'process.exitCode=7';
  const path = await fixture(`partial-${failure}`, `for (const event of ${JSON.stringify(events)}) console.log(JSON.stringify(event)); ${tail};`);
  const result = await startPiChild(path, [], dir, process.env, () => {}).closed;
  expect(result.output).toBe('Visible partial answer');
  expect(result.error).toBeTruthy();
  expect(result.truncated).toBe(failure === 'oversized');
});

// Isolate the host too: an uncaught close-handler exception must fail this test,
// rather than crashing the Vitest worker or being hidden by its exception hooks.
it.each([
  ['missing-content', { role: 'assistant', stopReason: 'stop' }],
  ['null-content', { role: 'assistant', stopReason: 'stop', content: null }],
  ['null-content-eof', { role: 'assistant', stopReason: 'stop', content: null }],
  ['non-array-content', { role: 'assistant', stopReason: 'stop', content: {} }],
  ['null-block', { role: 'assistant', stopReason: 'stop', content: [null] }],
  ['non-text-value', { role: 'assistant', stopReason: 'stop', content: [{ type: 'text', text: {} }] }],
  ['bad-stop', { role: 'assistant', stopReason: 'unknown', content: [] }],
  ['bad-usage', { role: 'assistant', stopReason: 'stop', content: [], usage: { input: '999' } }],
  ['bad-error', { role: 'assistant', stopReason: 'stop', content: [], errorMessage: {} }],
  ['null-usage', { role: 'assistant', stopReason: 'stop', content: [], usage: null }],
  ['null-cost', { role: 'assistant', stopReason: 'stop', content: [], usage: { input: 42, cost: null } }],
])('keeps the host alive and preserves validated state on %s', async (name, message) => {
  const childPath = await fixture(`damaged-${name}`, `
    console.log(JSON.stringify({type:'message_end',message:{role:'assistant',stopReason:'toolUse',content:[{type:'text',text:'Earlier answer'}]}}));
    console.log(JSON.stringify({type:'message_start',message:{role:'assistant'}}));
    console.log(JSON.stringify({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Current partial answer'}}));
    process.stdout.write(JSON.stringify({type:'message_end',message:${JSON.stringify(message)}}) + ${JSON.stringify(name.endsWith('-eof') ? '' : '\n')});
  `);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'packages/feature/agent/src/server/engines/shared/piSubagentProcess.ts')).href;
  const hostPath = await fixture(`host-${name}`, `
    const imported = await import(${JSON.stringify(moduleUrl)});
    const start = imported.startPiChild ?? imported.default.startPiChild;
    const child = start(${JSON.stringify(childPath)}, [], ${JSON.stringify(dir)}, process.env, () => {});
    const result = await child.closed;
    console.log(JSON.stringify({ closed: child.isClosed(), result }));
  `);
  const { stdout } = await promisify(execFile)(process.execPath, ['--import', 'tsx', hostPath], { cwd: process.cwd(), timeout: 5000 });
  const { closed, result } = JSON.parse(stdout);
  expect(closed).toBe(true);
  expect(result.error).toContain('Invalid Pi JSON event');
  expect(result.output).toBe('Current partial answer');
  expect(result.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, turns: 1 });
  expect(result.needsHistoryFallback).toBe(true);
});
