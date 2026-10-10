/**
 * Constraint: AgentDocsSingleSource (architecture rule, L4).
 *
 * AGENTS.md is the one real file of agent instructions (read by Codex and
 * other agents); CLAUDE.md is a symlink to it (read by Claude Code, which
 * follows the link). Two copies cannot drift if there is only one.
 *
 * Why: the two used to be separate files edited by hand, and AGENTS.md fell
 * behind (it was missing the whole `/skills/` section).
 */
import { lstatSync, readlinkSync } from 'fs';
import { join } from 'path';
import { describe, expect, it } from 'vitest';

const ROOT = join(__dirname, '..');

describe('AgentDocsSingleSource', () => {
  it('AGENTS.md is a regular file', () => {
    expect(lstatSync(join(ROOT, 'AGENTS.md')).isFile()).toBe(true);
  });

  it('CLAUDE.md is a symlink to AGENTS.md', () => {
    const claude = join(ROOT, 'CLAUDE.md');
    expect(lstatSync(claude).isSymbolicLink()).toBe(true);
    expect(readlinkSync(claude)).toBe('AGENTS.md');
  });
});
