// Real stubborn processes exercise the same Effect owner used by the subagent tool.
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { beforeAll, afterAll, expect, it, vi } from 'vitest';
import { Effect } from 'effect';
import { SessionManager } from '@earendil-works/pi-coding-agent';
import { startPiChild, type PiChildProcess, type PiChildResult } from '../server/engines/shared/piSubagentProcess';
import { runPiChildProcess } from './piSubagentProcessLive';
import { retainPiChildPartial } from './piSubagentSessionLive';
import { piBranchMessages } from '../server/engines/piEvents';

let dir: string;
beforeAll(async () => { dir = await mkdtemp(join(tmpdir(), 'pi-fatal-shutdown-')); });
afterAll(async () => { await rm(dir, { recursive: true, force: true }); });
it.each(['malformed', 'oversized', 'rpc-error', 'cancel-race', 'structured', 'structured-cancel'])(
  'closes a TERM-resistant process after %s and only then persists partial output', async (failure) => {
    const entry = join(dir, `${failure}.mjs`);
    const log = join(dir, `${failure}.log`);
    const instructions = join(dir, `${failure}.instructions`);
    await writeFile(instructions, 'temporary instructions');
    const session = SessionManager.create(dir, join(dir, failure));
    session.appendMessage({ role: 'user', content: 'delegated work', timestamp: Date.now() });
    const history = session.getSessionFile()!;
    const fault = failure === 'oversized' ? 'console.log("x".repeat(2100000))'
      : failure === 'rpc-error' ? 'emit({type:"response",id:"cockpit-prompt",command:"prompt",success:false,error:"RPC rejected"})'
      : failure.startsWith('structured') ? 'emit({type:"message_end",message:{role:"assistant",content:null,stopReason:"stop"}})'
      : 'console.log("not-json")';
    await writeFile(entry, `
      import { appendFileSync, existsSync } from 'node:fs';
      import { createInterface } from 'node:readline';
      const record = (text) => appendFileSync(${JSON.stringify(log)}, text + '\\n');
      const emit = (event) => console.log(JSON.stringify(event));
      process.on('SIGTERM', () => record('TERM:' + existsSync(${JSON.stringify(instructions)})));
      setInterval(() => {}, 1000);
      createInterface({input:process.stdin}).on('line', (line) => {
        const command = JSON.parse(line);
        if (command.type === 'abort') { record('ABORT'); return; }
        if (command.type !== 'prompt') return;
        emit({type:'response',id:'cockpit-prompt',command:'prompt',success:true});
        emit({type:'message_start',message:{role:'assistant'}});
        emit({type:'message_update',assistantMessageEvent:{type:'text_delta',delta:'Retained partial ${failure}'}});
        ${fault};
      });
    `);
    const controller = new AbortController();
    let child!: PiChildProcess;
    let finished: PiChildResult | undefined;
    let cleanupCount = 0;
    const program = runPiChildProcess(Effect.sync(() => {
      child = startPiChild(entry, [], dir, process.env, () => {}, 'task');
      child.cancel = vi.fn(child.cancel);
      child.terminate = vi.fn(child.terminate);
      child.kill = vi.fn(child.kill);
      if (failure.includes('cancel')) void child.failed.then(() => controller.abort());
      return child;
    }), (result) => Effect.gen(function* () {
      expect(child.isClosed()).toBe(true);
      finished = result; cleanupCount++;
      yield* retainPiChildPartial(history, result.output).pipe(Effect.orDie);
      yield* Effect.promise(() => rm(instructions));
    }));
    try {
      const pending = Effect.runPromise(program, { signal: controller.signal });
      if (failure.includes('cancel')) await expect(pending).rejects.toThrow();
      else await pending;
      expect(child.isClosed()).toBe(true);
      expect(child.cancel).toHaveBeenCalledTimes(1);
      expect(child.terminate).toHaveBeenCalledTimes(1);
      expect(child.kill).toHaveBeenCalledTimes(1);
      expect(await readFile(log, 'utf8')).toBe('ABORT\nTERM:true\n');
      expect(cleanupCount).toBe(1);
      expect(finished?.output).toBe(`Retained partial ${failure}`);
      expect(finished?.error).toContain(failure === 'oversized' ? 'exceeded 2 MiB' : failure === 'rpc-error' ? 'RPC rejected' : 'Invalid Pi JSON event');
      expect(finished?.error).toContain('signal=SIGKILL');
      expect(finished?.truncated).toBe(failure === 'oversized');
      expect(JSON.stringify(piBranchMessages(SessionManager.open(history).getBranch()))).toContain(`Retained partial ${failure}`);
      await expect(readFile(instructions)).rejects.toMatchObject({ code: 'ENOENT' });
    } finally { if (child && !child.isClosed()) { child.kill(); await child.closed; } }
  }, 15000,
);
