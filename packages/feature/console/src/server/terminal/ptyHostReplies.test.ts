/**
 * Terminal-query replies reach a program that is waiting for them, and never
 * reach the shell prompt (bin/pty-host.mjs dropOrphanReplies).
 *
 * Drives the real host over its socket: the decision depends on the PTY's
 * foreground process, which only a real PTY has.
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, rmSync } from 'fs';
import { connect, type Socket } from 'net';
import { tmpdir } from 'os';
import { join } from 'path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const HOST = join(__dirname, '../../../../../../bin/pty-host.mjs');
const CPR_REPLY = '\x1b[12;1R';
const BG_REPLY = '\x1b]11;rgb:0000/0000/0000\x1b\\';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe.skipIf(process.platform === 'win32')('pty-host terminal-query replies', () => {
  let dir: string;
  let host: ChildProcess;
  let sock: Socket;
  const output = new Map<string, string>();

  const send = (msg: object) => sock.write(JSON.stringify(msg) + '\n');
  const waitFor = async (id: string, needle: string, ms = 5000) => {
    const end = Date.now() + ms;
    while (Date.now() < end) {
      if ((output.get(id) ?? '').includes(needle)) return;
      await sleep(25);
    }
    throw new Error(`timed out waiting for ${JSON.stringify(needle)} in ${JSON.stringify(output.get(id))}`);
  };
  const spawnPty = async (id: string, file: string, args: string[]) => {
    send({ op: 'spawn', id, kind: 'pty', file, args, cwd: dir, env: { PATH: process.env.PATH, TERM: 'xterm-256color' }, cols: 80, rows: 24 });
  };

  beforeAll(async () => {
    dir = mkdtempSync(join(tmpdir(), 'pty-replies-'));
    const socketPath = join(dir, 'h.sock');
    host = spawn(process.execPath, [HOST, '--serve', '--socket', socketPath, '--dir', dir], { stdio: 'ignore' });
    for (let i = 0; i < 100 && !sock; i++) {
      await sleep(50);
      sock = await new Promise<Socket>((resolve) => {
        const s = connect(socketPath);
        s.once('connect', () => resolve(s));
        s.once('error', () => resolve(undefined as unknown as Socket));
      });
    }
    let buf = '';
    sock.on('data', (chunk) => {
      buf += chunk.toString();
      let nl;
      while ((nl = buf.indexOf('\n')) !== -1) {
        const msg = JSON.parse(buf.slice(0, nl));
        buf = buf.slice(nl + 1);
        if (msg.ev === 'data') output.set(msg.id, (output.get(msg.id) ?? '') + msg.data);
      }
    });
  });

  afterAll(() => {
    try { send({ op: 'shutdown' }); } catch { /* gone */ }
    sock?.destroy();
    host?.kill();
    rmSync(dir, { recursive: true, force: true });
  });

  it('delivers the reply to a foreground program that asked for it', async () => {
    // Like survey/termenv: ask, then block reading stdin until the reply lands.
    const asker = [
      "process.stdin.setRawMode(true);",
      "process.stdout.write('ASK\\x1b[6n');",
      "let got = '';",
      "process.stdin.on('data', (d) => { got += d; if (got.includes('R')) { process.stdout.write('GOT ' + JSON.stringify(got) + '\\n'); process.exit(0); } });",
    ].join('');
    await spawnPty('asker', process.execPath, ['-e', asker]);
    await waitFor('asker', 'ASK');
    send({ op: 'write', id: 'asker', data: CPR_REPLY });
    await waitFor('asker', 'GOT');
    expect(output.get('asker')).toContain(JSON.stringify(CPR_REPLY));
  });

  it('drops a late reply when the shell itself is in the foreground', async () => {
    // `read` is a builtin, so sh stays the foreground process while it reads.
    await spawnPty('shell', '/bin/sh', ['-c', "echo READY; read line; printf 'LINE[%s]\\n' \"$line\""]);
    await waitFor('shell', 'READY');
    await sleep(200);
    send({ op: 'write', id: 'shell', data: CPR_REPLY + BG_REPLY });
    send({ op: 'write', id: 'shell', data: 'typed\r' });
    await waitFor('shell', 'LINE[');
    expect(output.get('shell')).toContain('LINE[typed]');
  });
});
