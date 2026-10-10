/**
 * Constraint: OneInstancePerDataDir (invariant, L2 + structural L4).
 *
 * However many Cockpit processes start at once on one data dir, exactly one
 * gets to boot. The decision is made by an exclusive create of
 * <home>/server.lock before anything else starts (in particular before Next
 * and the scheduler), not by probing for an instance that is already
 * listening. A lock left by a dead process is taken over — again by exactly
 * one of the contenders.
 *
 * Why: the guard probed the recorded instance's /api/health. Two processes
 * started together (service autostart plus a manual `cockpit`, on different
 * ports) both found nothing listening yet and both booted on one data dir,
 * running two schedulers that fired every task twice.
 *
 * The race is real: N separate node processes contend for the lock at once.
 */
import { spawn } from 'child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');
const LOCK_MODULE = join(ROOT, 'bin/instanceLock.mjs');
const dirs: string[] = [];
afterAll(() => { for (const d of dirs) rmSync(d, { recursive: true, force: true }); });

const freshHome = () => {
  const d = mkdtempSync(join(tmpdir(), 'cockpit-one-instance-'));
  dirs.push(d);
  return d;
};

/** Start `n` processes that each try to take the lock, report, then hold until killed. */
async function contend(home: string, n: number): Promise<{ won: number; lost: number }> {
  const script = `
    const { acquireInstanceLock } = await import(${JSON.stringify(LOCK_MODULE)});
    await new Promise((r) => setTimeout(r, Number(process.env.START_AT) - Date.now()));
    const res = acquireInstanceLock(process.env.HOME_DIR);
    process.stdout.write(res.ok ? 'won\\n' : 'lost\\n');
    setInterval(() => {}, 1000);
  `;
  const startAt = String(Date.now() + 800); // line them all up on one instant
  const procs = Array.from({ length: n }, () =>
    spawn(process.execPath, ['--input-type=module', '-e', script], {
      env: { ...process.env, HOME_DIR: home, START_AT: startAt },
      stdio: ['ignore', 'pipe', 'inherit'],
    }),
  );
  const results = await Promise.all(
    procs.map((p) => new Promise<string>((resolve) => {
      let out = '';
      p.stdout!.on('data', (d) => {
        out += d;
        if (out.includes('\n')) resolve(out.trim());
      });
      p.on('exit', () => resolve(out.trim() || 'exited'));
    })),
  );
  for (const p of procs) p.kill('SIGKILL');
  await Promise.all(procs.map((p) => new Promise((r) => (p.exitCode !== null || p.signalCode ? r(null) : p.on('exit', r)))));
  return { won: results.filter((r) => r === 'won').length, lost: results.filter((r) => r === 'lost').length };
}

describe('OneInstancePerDataDir', () => {
  it('of many processes starting at once on a fresh data dir, exactly one boots', async () => {
    for (let round = 0; round < 3; round++) {
      expect(await contend(freshHome(), 8)).toEqual({ won: 1, lost: 7 });
    }
  }, 30_000);

  it('a lock left by a dead process is taken over by exactly one contender', async () => {
    for (let round = 0; round < 3; round++) {
      const home = freshHome();
      // A pid that is certainly gone: a child that has already exited.
      const dead = spawn(process.execPath, ['-e', '']);
      await new Promise((r) => dead.on('exit', r));
      writeFileSync(join(home, 'server.lock'), JSON.stringify({ pid: dead.pid }));
      expect(await contend(home, 8)).toEqual({ won: 1, lost: 7 });
    }
  }, 30_000);

  it('a lock held by a live process is respected', async () => {
    const home = freshHome();
    writeFileSync(join(home, 'server.lock'), JSON.stringify({ pid: process.pid }));
    expect(await contend(home, 3)).toEqual({ won: 0, lost: 3 });
  }, 30_000);

  it('server.mjs takes the lock before it starts Next', () => {
    const file = join(ROOT, 'server.mjs');
    const sf = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    const calls: Array<{ name: string; pos: number }> = [];
    const visit = (n: ts.Node): void => {
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) calls.push({ name: n.expression.text, pos: n.getStart() });
      ts.forEachChild(n, visit);
    };
    visit(sf);
    const lockAt = calls.find((c) => c.name === 'acquireInstanceLock')?.pos ?? -1;
    const nextAt = calls.find((c) => c.name === 'next')?.pos ?? -1;
    expect(lockAt, 'acquireInstanceLock is called').toBeGreaterThan(-1);
    expect(nextAt).toBeGreaterThan(-1);
    expect(lockAt).toBeLessThan(nextAt);
  });
});
