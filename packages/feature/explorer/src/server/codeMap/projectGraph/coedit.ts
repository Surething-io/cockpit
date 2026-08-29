/**
 * Co-edit projection — files that are frequently changed alongside a target
 * file, derived from git history + working-tree state.
 *
 * Why this exists: the call-graph projections (callers/callees/impact) can
 * only express STATIC relationships — "X calls Y", "Y imports X". They can't
 * see CONVENTIONAL coupling: two parallel registries that have to stay in
 * sync but never mention each other in source. The canonical example in
 * cockpit is a shipped asset directory: `paths.ts` resolves it under
 * COCKPIT_ROOT (APPS_DIR / BUILTIN_SKILLS_SRC_DIR) while `package.json#files`
 * decides whether it lands in the npm tarball at all — miss the second edit and
 * the feature works in the checkout and 404s for every installed user, with no
 * import anywhere linking the two files.
 *
 * Humans encode these conventions in git history: when `skills/` was added,
 * both files were edited in the same commit. So files that co-appear in commits
 * with the target are a strong signal of conventional coupling, regardless
 * of whether the language semantics see any connection.
 *
 * Two sources, both essential:
 *   1. `git log` history — past co-edits (the "we've been doing this together")
 *   2. `git status` working tree — current uncommitted co-edits (the "we're
 *      doing this together RIGHT NOW", which history can't see yet)
 *
 * Source 2 matters because AI is often called mid-edit, before commit. If we
 * only looked at history, a brand-new dual edit would be invisible until
 * after commit. The working-tree pass closes that gap.
 *
 * Stateless: no caching, every request shells out fresh. Calls are cheap
 * (~15 ms on typical repos because git uses packfile indexes) so a per-
 * request cache would be premature optimisation.
 */

import { exec } from 'node:child_process';
import { promisify } from 'node:util';

const execAsync = promisify(exec);

export interface CoEditHistoryEntry {
  /** Project-relative path of the co-edited file. */
  file: string;
  /** Number of commits in the scanned window where both this file and the
   *  target appeared. */
  cooccurrence: number;
  /** ISO date of the most recent co-edit commit. Empty when the entry has
   *  no commit (shouldn't happen in history; reserved for future). */
  lastCoEdit: string;
}

export interface CoEditResponse {
  /** Echo of the input filePath, project-relative. */
  target: string;
  /** Number of commits in the scanned window that touched the target.
   *  Useful as a denominator: cooccurrence / totalCommits = "what fraction
   *  of edits to X also touched this file?". */
  totalCommits: number;
  /** Co-edit history, sorted by cooccurrence desc, then lastCoEdit desc.
   *  Skips files that appear in big commits (>BIG_COMMIT_THRESHOLD files)
   *  to avoid "big refactor" noise. */
  history: CoEditHistoryEntry[];
  /** Files currently modified or staged alongside the target in the working
   *  tree. Captures in-flight edits that haven't been committed yet. Sorted
   *  alphabetically. Empty when target itself isn't in working-tree state
   *  (i.e. nothing to "co-edit with"). */
  uncommitted: string[];
}

/** A commit touching too many files is almost always a sweep/refactor; the
 *  co-edit signal it carries is too weak to be useful and creates noise.
 *  Tunable — 30 covers most real product commits while filtering out the
 *  "moved 200 files" reorganizations. */
const BIG_COMMIT_THRESHOLD = 30;

/** Maximum number of commits to scan when building history. git log is fast
 *  (~15 ms for 100+ commits via packfile index) so a larger N is cheap; we
 *  cap to bound memory + JSON response size. */
const DEFAULT_COMMITS = 100;
const MAX_COMMITS = 1000;

/**
 * Run `git log --follow` against the target and parse co-edit signal.
 *
 * The `--follow` flag lets git track renames so a file that was moved still
 * accumulates history. The trade-off: --follow only works on a single
 * pathspec; passing multiple files at once doesn't.
 *
 * `--name-only` lists every file touched per commit; we delimit commits with
 * a fixed sentinel line so parsing is unambiguous.
 */
async function collectHistory(
  cwd: string,
  filePath: string,
  commits: number,
  granularity: 'commit' | 'merge' = 'commit',
): Promise<{ history: CoEditHistoryEntry[]; totalCommits: number }> {
  // Sentinel separator: `---SEP---<hash>|<ISO-date>` is a line that can't
  // appear inside a filename, so splitting on the sentinel is safe.
  const SEP = '---SEP---';
  // P0-2: "merge" granularity walks first-parent merge commits with
  //   --merges --first-parent. On squash-style projects (where each
  //   commit touches a single file but a PR contains a logical cluster
  //   of changes), this surfaces the cluster — which is exactly the
  //   co-edit signal we want. `--follow` doesn't apply (it's a single-
  //   pathspec flag and merges can rename across many files), so we
  //   accept the trade-off that file renames may break a merge's
  //   coupling chain. For modern workflows this is rarely a problem.
  const baseFlags =
    granularity === 'merge'
      ? `--merges --first-parent --name-only`
      : `--follow --name-only`;
  let stdout: string;
  try {
    const result = await execAsync(
      `git log -n ${commits} ${baseFlags} ` +
        `--pretty=format:'${SEP}%H|%cI' -- ${shellQuote(filePath)}`,
      { cwd, maxBuffer: 50 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    // Not a git repo, file never tracked, or git missing → empty.
    return { history: [], totalCommits: 0 };
  }

  // Parse into commits. Each commit chunk: a separator line, then 0+ file
  // lines until the next separator (or EOF). The first chunk may have an
  // empty separator if git starts with --pretty output immediately.
  type Commit = { hash: string; date: string; files: string[] };
  const commitsList: Commit[] = [];
  const chunks = stdout.split(SEP).slice(1); // drop leading empty
  for (const chunk of chunks) {
    const lines = chunk.split('\n');
    const header = lines[0]; // "<hash>|<date>"
    const sep = header.indexOf('|');
    if (sep < 0) continue;
    const hash = header.slice(0, sep);
    const date = header.slice(sep + 1);
    const files = lines.slice(1).map((l) => l.trim()).filter(Boolean);
    if (!hash) continue;
    commitsList.push({ hash, date, files });
  }

  // Aggregate co-occurrence. For each commit (excluding big-commit noise),
  // every NON-target file gets +1 to cooccurrence and its lastCoEdit
  // updated if this commit is newer.
  const byFile = new Map<string, CoEditHistoryEntry>();
  for (const c of commitsList) {
    if (c.files.length === 0) continue;
    if (c.files.length > BIG_COMMIT_THRESHOLD) continue; // skip refactor sweeps
    for (const f of c.files) {
      if (f === filePath) continue;
      const existing = byFile.get(f);
      if (existing) {
        existing.cooccurrence += 1;
        if (c.date > existing.lastCoEdit) existing.lastCoEdit = c.date;
      } else {
        byFile.set(f, { file: f, cooccurrence: 1, lastCoEdit: c.date });
      }
    }
  }

  const history = Array.from(byFile.values()).sort(
    (a, b) =>
      b.cooccurrence - a.cooccurrence ||
      b.lastCoEdit.localeCompare(a.lastCoEdit) ||
      a.file.localeCompare(b.file),
  );

  return { history, totalCommits: commitsList.length };
}

/**
 * Inspect the working tree for files currently modified or staged alongside
 * the target. The semantic: if the target itself is in working-tree state,
 * the other modified+staged files are "what we're editing with X right now".
 *
 * Why not include untracked (`??`) files: they're noise — temp files, build
 * artifacts, drafts. A user genuinely co-creating a NEW file would `git add`
 * it first, which moves it to staged (`A` / `AM`) and we'd pick it up.
 */
async function collectUncommitted(
  cwd: string,
  filePath: string,
): Promise<string[]> {
  let stdout: string;
  try {
    const result = await execAsync(
      'git -c core.quotePath=false status --porcelain',
      { cwd, maxBuffer: 10 * 1024 * 1024 },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  // Each line: `XY filename` where X = index status, Y = worktree status.
  // We want anything where X or Y is non-space-non-?, i.e. tracked changes
  // (M / A / D / R / C / U). Untracked `??` is intentionally excluded.
  const modified: string[] = [];
  for (const rawLine of stdout.split('\n')) {
    if (rawLine.length < 4) continue;
    const X = rawLine[0];
    const Y = rawLine[1];
    if (X === '?' && Y === '?') continue;
    // Rename lines look like `R  old -> new`; we want the new path.
    let path = rawLine.slice(3).trim();
    const arrow = path.indexOf(' -> ');
    if (arrow >= 0) path = path.slice(arrow + 4).trim();
    // Strip possible surrounding quotes (git quotes paths with special chars
    // unless core.quotePath=false, which we set above — belt-and-braces).
    if (path.startsWith('"') && path.endsWith('"')) {
      path = path.slice(1, -1);
    }
    modified.push(path);
  }

  // If the target itself isn't in the modified set, there's nothing "with"
  // it in the working tree.
  if (!modified.includes(filePath)) return [];

  return modified
    .filter((f) => f !== filePath)
    .sort((a, b) => a.localeCompare(b));
}

/** Conservative shell-quoter for a path argument. We avoid shell-meta
 *  expansion by single-quoting and escaping any single quotes inside. */
function shellQuote(s: string): string {
  return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build the co-edit response for a target file. `commits` controls the
 * git-log scan window (default 100, max 1000). Both history and uncommitted
 * collection run in parallel since they're independent git invocations.
 */
export async function coEditFromGit(
  cwd: string,
  filePath: string,
  commits: number = DEFAULT_COMMITS,
  granularity: 'commit' | 'merge' = 'commit',
): Promise<CoEditResponse> {
  const n = Math.min(Math.max(commits, 1), MAX_COMMITS);
  const [{ history, totalCommits }, uncommitted] = await Promise.all([
    collectHistory(cwd, filePath, n, granularity),
    collectUncommitted(cwd, filePath),
  ]);
  return { target: filePath, totalCommits, history, uncommitted };
}

/** P0-2: Two-pass coedit — try commit granularity first, fall back to
 *  merge granularity if the commit pass returns insufficient signal.
 *  This handles both:
 *    - Feature-branch / many-files-per-commit projects (commit signal works)
 *    - Squash / single-file commit projects (merge signal needed)
 *
 *  Callers that want the auto-best signal call this instead of
 *  `coEditFromGit` directly. Returns the better of the two. */
export async function coEditAuto(
  cwd: string,
  filePath: string,
  commits: number = DEFAULT_COMMITS,
): Promise<CoEditResponse> {
  const byCommit = await coEditFromGit(cwd, filePath, commits, 'commit');
  // Heuristic: if commit-granularity produced any history rows at all,
  // use it (it's higher-precision than merge granularity). Only fall
  // back to merges when commit gives us nothing useful.
  if (byCommit.history.length > 0) return byCommit;
  const byMerge = await coEditFromGit(cwd, filePath, commits, 'merge');
  return byMerge;
}
