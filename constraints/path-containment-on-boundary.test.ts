/**
 * Constraint: PathContainmentOnBoundary (permission, L2 property-based + structural L4).
 *
 * "Is this path inside that directory?" is decided on a path-segment
 * boundary: `/a/foo/x` is inside `/a/foo`, `/a/foobar` is not. Concretely:
 *
 * - POST /api/files/paste refuses any target directory that resolves outside
 *   the project, including a sibling whose name merely starts with the
 *   project's name.
 * - No code under src/ or packages/ checks containment with a bare
 *   `x.startsWith(root)` (or `root + "/"`, which never matches a Windows
 *   path): it uses isPathWithin / relativeToRoot from shared-utils, or appends
 *   the platform separator.
 *
 * Why: paste checked `targetAbsDir.startsWith(basePath)`, so `../foobar` from
 * project `/a/foo` pasted into `/a/foobar`. Three client views stripped a cwd
 * prefix the same way and showed `/a/foobar/x.ts` as `bar/x.ts`. copy used
 * `basePath + "/"`, which refuses every path on Windows.
 */
import fc from 'fast-check';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join, relative, resolve, sep } from 'path';
import ts from 'typescript';
import { afterAll, describe, expect, it } from 'vitest';
import { POST as paste } from '../packages/feature/explorer/src/server/api/files/paste';

const ROOT = join(__dirname, '..');
const work = mkdtempSync(join(tmpdir(), 'cockpit-containment-'));
afterAll(() => rmSync(work, { recursive: true, force: true }));

const project = join(work, 'foo');
mkdirSync(join(project, 'sub'), { recursive: true });
const source = join(work, 'source.txt');
writeFileSync(source, 'x');
for (const sibling of ['foobar', 'foo-old', 'foo.bak', 'fo', 'other']) mkdirSync(join(work, sibling), { recursive: true });

const pasteInto = async (targetDir: string) =>
  (paste as (req: Request) => Promise<Response>)(
    new Request('http://localhost/api/files/paste', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ cwd: project, targetDir, sourceAbsPath: source }),
    }),
  );

describe('PathContainmentOnBoundary', () => {
  it('paste refuses every target outside the project, prefix-named siblings included', async () => {
    const outside = fc.oneof(
      fc.constantFrom('../foobar', '../foo-old', '../foo.bak', '../fo', '../other', '..', '../..'),
      fc.constantFrom('foobar', 'foo-old', 'other').map((s) => `sub/../../${s}`),
    );
    await fc.assert(
      fc.asyncProperty(outside, async (targetDir) => {
        const res = await pasteInto(targetDir);
        return res.status === 403;
      }),
      { numRuns: 40 },
    );
    expect(readdirSync(join(work, 'foobar'))).toEqual([]);
  });

  it('paste still accepts the project root and its subdirectories', async () => {
    for (const targetDir of ['', 'sub', './sub', 'sub/../sub']) {
      const res = await pasteInto(targetDir);
      expect(res.status, `targetDir=${JSON.stringify(targetDir)}`).toBe(200);
    }
  });

  it('no containment check is a bare prefix match', () => {
    const SKIP = new Set(['node_modules', '.next', '.next-prod', 'dist']);
    const ROOTISH = /(base|root|cwd|dir|home|project)/i;
    const hits: string[] = [];
    const walk = (p: string): void => {
      if (statSync(p).isDirectory()) {
        for (const n of readdirSync(p)) if (!SKIP.has(n)) walk(join(p, n));
        return;
      }
      if (!/\.tsx?$/.test(p) || /\.test\.tsx?$/.test(p)) return;
      const text = readFileSync(p, 'utf8');
      if (!text.includes('.startsWith(')) return;
      const sf = ts.createSourceFile(p, text, ts.ScriptTarget.Latest, true);
      const visit = (n: ts.Node): void => {
        if (
          ts.isCallExpression(n) &&
          ts.isPropertyAccessExpression(n.expression) &&
          n.expression.name.text === 'startsWith' &&
          n.arguments.length === 1
        ) {
          const arg = n.arguments[0];
          const subject = n.expression.expression.getText(sf);
          const bare = (ts.isIdentifier(arg) || ts.isPropertyAccessExpression(arg)) && ROOTISH.test(arg.getText(sf));
          const slashOnly =
            ts.isBinaryExpression(arg) &&
            ROOTISH.test(arg.left.getText(sf)) &&
            ts.isStringLiteralLike(arg.right) && arg.right.text === '/';
          // Only path-shaped subjects: string prefix checks on URLs, text, ids are fine.
          if ((bare || slashOnly) && /path|file|full|abs|target|dest|dir/i.test(subject)) {
            const { line } = sf.getLineAndCharacterOfPosition(n.getStart());
            hits.push(`${relative(ROOT, p)}:${line + 1}  ${n.getText(sf)}`);
          }
        }
        ts.forEachChild(n, visit);
      };
      visit(sf);
    };
    walk(join(ROOT, 'src'));
    walk(join(ROOT, 'packages'));
    expect(hits).toEqual([]);
  });

  it('isPathWithin decides on a segment boundary, for POSIX and Windows paths', async () => {
    const mod = (await import('../packages/shared/utils/src/index')) as Record<string, unknown>;
    const isPathWithin = mod.isPathWithin as ((root: string, p: string, allowRoot?: boolean) => boolean) | undefined;
    expect(isPathWithin, 'isPathWithin exported').toBeTypeOf('function');
    const seg = fc.stringMatching(/^[a-z0-9._-]{1,8}$/).filter((s) => s !== '.' && s !== '..');
    fc.assert(
      fc.property(fc.array(seg, { minLength: 1, maxLength: 4 }), seg, fc.string({ maxLength: 4 }).filter((s) => !/[/\\]/.test(s) && s.length > 0), fc.boolean(),
        (parts, child, suffix, win) => {
          const s = win ? '\\' : '/';
          const root = (win ? 'C:' : '') + s + parts.join(s);
          return (
            isPathWithin!(root, root + s + child) === true &&
            isPathWithin!(root, root + suffix) === false && // sibling sharing the prefix
            isPathWithin!(root, root) === false &&
            isPathWithin!(root, root, true) === true &&
            isPathWithin!(root + s, root + s + child) === true // trailing separator on the root
          );
        }),
      { numRuns: 300 },
    );
    expect(isPathWithin!(resolve('/a/foo'), resolve('/a/foo') + sep + 'x')).toBe(true);
  });
});
