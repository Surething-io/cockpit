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
 *
 * One fallback: when the create call's output carries no URL (the call timed
 * out and moved to the background, say, while the PR was in fact opened), the
 * session's next `gh pr view` / `gh pr list --head` / `gh pr create` output
 * that prints a PR URL resolves it — that is how an agent confirms the PR it
 * just made. It stays scoped to the turn that issued the create.
 */

const CREATE_COMMAND = /\bgh\s+pr\s+create\b/;
const VIEW_COMMAND = /\bgh\s+pr\s+view\b/;
// Only a head-filtered listing names the branch's own PR; a bare `gh pr list` lists everyone's.
const LIST_HEAD_COMMAND = /\bgh\s+pr\s+list\b[^\n;&|]*\s(?:--head|-H)(?:=|\s)/;

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

/** A command whose output names the branch's PR: the follow-up that resolves a URL-less create. */
export function isPullRequestLookupCommand(command: string): boolean {
  return CREATE_COMMAND.test(command) || VIEW_COMMAND.test(command) || LIST_HEAD_COMMAND.test(command);
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
