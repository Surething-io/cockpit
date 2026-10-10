/**
 * Constraint: OneRunPerCommandId (invariant, L2 + structural L4).
 *
 * At most one process runs under a console commandId. A rerun (exec with an id
 * that is still running) retires the old run first — kills it and waits until
 * it has left the registry, escalating to SIGKILL — and only then spawns. If
 * the old run outlives that, the rerun is refused rather than started beside
 * it.
 *
 * Why: exec overwrote the registry entry of a still-running command. The old
 * process kept running, unreachable from the UI (stop / delete could no longer
 * find it) and its exit was ignored. A double-clicked rerun did this every time
 * (the second click saw no pid and skipped the interrupt), and so did a rerun of
 * anything that ignores SIGINT (a shell, an editor, a dev server).
 *
 * COCKPIT_HOME is redirected to a temp dir BEFORE importing, because paths.ts
 * resolves COCKPIT_DIR once at module load.
 */
import { spawn, type ChildProcess } from 'child_process';
import { mkdtempSync, readFileSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const home = mkdtempSync(join(tmpdir(), 'cockpit-one-run-'));
process.env.COCKPIT_HOME = home;

type Registry = typeof import('../packages/feature/console/src/server/terminal/RunningCommandRegistry');
let reg: Registry;
const children: ChildProcess[] = [];

beforeAll(async () => {
  reg = await import('../packages/feature/console/src/server/terminal/RunningCommandRegistry');
});
afterAll(() => {
  for (const c of children) { try { c.kill('SIGKILL'); } catch { /* exited */ } }
  rmSync(home, { recursive: true, force: true });
});

const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

/** Start and register a pipe-mode run under `commandId`, as terminalHandler does. */
function startRun(commandId: string, script: string) {
  const child = spawn('sh', ['-c', script], { stdio: 'ignore' });
  children.push(child);
  reg.registerCommand({
    commandId, command: script, cwd: home, projectCwd: home, tabId: 'tab-1',
    pid: child.pid!, process: child, timestamp: new Date().toISOString(),
  });
  return child.pid!;
}

const retire = () => (reg as { retireRunningCommand?: (id: string, ms?: number) => Promise<boolean> }).retireRunningCommand;

describe('OneRunPerCommandId', () => {
  it('a rerun retires the still-running old process before the new one starts', async () => {
    const oldPid = startRun('cmd-1', 'exec sleep 300');
    expect(retire(), 'retireRunningCommand exported').toBeTypeOf('function');

    await expect(retire()!('cmd-1')).resolves.toBe(true);
    expect(alive(oldPid)).toBe(false);
    expect(reg.getRunningCommand('cmd-1')).toBeUndefined();

    const newPid = startRun('cmd-1', 'exec sleep 300');
    expect(reg.getRunningCommand('cmd-1')?.pid).toBe(newPid);
    await retire()!('cmd-1');
  });

  it('an old run that ignores SIGINT / SIGTERM is still retired (SIGKILL)', async () => {
    const oldPid = startRun('cmd-2', 'trap "" INT TERM; exec sleep 300');
    expect(retire(), 'retireRunningCommand exported').toBeTypeOf('function');

    await expect(retire()!('cmd-2', 5000)).resolves.toBe(true);
    expect(alive(oldPid)).toBe(false);
    expect(reg.getRunningCommand('cmd-2')).toBeUndefined();
  }, 10_000);

  it('the exec handler retires a running command before it spawns', () => {
    const file = join(__dirname, '../src/lib/effect/terminalHandler.ts');
    const text = readFileSync(file, 'utf8');
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
    const calls: Array<{ name: string; pos: number }> = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        calls.push({ name: n.expression.text, pos: n.getStart() });
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const retireAt = calls.find((c) => c.name === 'retireRunningCommand')?.pos ?? -1;
    const spawnAt = calls.filter((c) => c.name === 'spawnPtyInHost' || c.name === 'spawnPipeInHost').map((c) => c.pos);
    expect(retireAt, 'retireRunningCommand is called').toBeGreaterThan(-1);
    expect(spawnAt.length).toBeGreaterThan(0);
    // The guard is checked before the spawn code it gates.
    for (const s of spawnAt) expect(retireAt).toBeLessThan(s);
  });
});
