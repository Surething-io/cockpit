/**
 * Pull-request detection for transcripts, plus the query parser the PR board's
 * search box uses. Pure string work, client-importable (no node built-ins).
 *
 * What counts as "a PR this session opened": a shell call whose command runs
 * `gh pr create`, and the first PR URL its output printed. `gh pr create`
 * prints the new PR's URL on success, and the existing PR's URL when one is
 * already open for the branch — both are the branch's PR, so both count. PR
 * links that only appear in prose (a pasted review link, a PR listing) are not
 * recorded: the board lists what sessions created, not everything they mention.
 */

const CREATE_COMMAND = /\bgh\s+pr\s+create\b/;

// `/pull/new/<branch>` (git push's hint) has no number, so it never matches.
const PR_URL = /https:\/\/github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/pull\/(\d+)/;

/** `--title 'x'`, `--title "x"`, `--title=x`, `-t x`. */
const TITLE_FLAG = /(?:^|\s)(?:--title|-t)(?:=|\s+)(?:'([^']*)'|"((?:[^"\\]|\\.)*)"|([^\s'"]+))/;

export interface PullRequestRef {
  url: string;
  repo: string;
  number: number;
}

export function isPullRequestCreateCommand(command: string): boolean {
  return CREATE_COMMAND.test(command);
}

/** First PR URL in `text`, canonicalised. */
export function findPullRequestUrl(text: string): PullRequestRef | null {
  const m = PR_URL.exec(text);
  if (!m) return null;
  const repo = `${m[1]}/${m[2]}`;
  const number = Number(m[3]);
  return { url: `https://github.com/${repo}/pull/${number}`, repo, number };
}

/** The `--title` a `gh pr create` command line passes, if it is spelled inline. */
export function pullRequestTitleOf(command: string): string | undefined {
  const m = TITLE_FLAG.exec(command);
  if (!m) return undefined;
  const raw = m[1] ?? m[2]?.replace(/\\(.)/g, '$1') ?? m[3];
  const title = raw?.trim();
  return title || undefined;
}

/**
 * What a PR-board search string pins down, if it names a PR: a full URL,
 * `owner/repo#12`, `repo#12`, `#12` or a bare `12`. `null` means a free-text
 * query (match titles instead).
 */
export interface PullRequestQuery {
  number: number;
  /** Lowercased `owner/repo` or `repo`; absent when only the number was given. */
  repo?: string;
}

export function parsePullRequestQuery(input: string): PullRequestQuery | null {
  const q = input.trim();
  if (!q) return null;
  const url = findPullRequestUrl(q);
  if (url) return { number: url.number, repo: url.repo.toLowerCase() };
  const m = /^(?:([A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)?)#|#)?(\d+)$/.exec(q);
  if (!m) return null;
  return { number: Number(m[2]), repo: m[1]?.toLowerCase() };
}

/** Does `pr` satisfy a parsed PR query? A bare repo name matches `owner/<repo>`. */
export function matchesPullRequestQuery(pr: { repo: string; number: number }, query: PullRequestQuery): boolean {
  if (pr.number !== query.number) return false;
  if (!query.repo) return true;
  const repo = pr.repo.toLowerCase();
  return query.repo.includes('/') ? repo === query.repo : repo.split('/')[1] === query.repo;
}
