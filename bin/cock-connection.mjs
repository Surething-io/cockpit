#!/usr/bin/env node

/**
 * cockpit connection — cross-type bubble enumeration.
 *
 * One subcommand:
 *
 *   cockpit connection list [--cwd PATH] [--all] [--json]
 *
 * Returns a unified listing of terminal + browser bubbles, each with the
 * user-set `title` (if any). Designed for /cc slash mode and ad-hoc
 * "what bubbles exist in this project" lookups before driving them via
 * `cockpit terminal <id> ...` / `cockpit browser <id> ...`.
 *
 * By default only alive bubbles (running terminal / connected browser)
 * are returned. Pass `--all` to include stale entries.
 */
import { readFileSync } from 'fs';
import { join, resolve } from 'path';
import { homedir } from 'os';

const argv = process.argv.slice(2);

function readServerPort() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.cockpit', 'server.json'), 'utf8')).port;
  } catch {
    return null;
  }
}

const port = process.env.COCKPIT_PORT || readServerPort() || 3457;
const baseUrl = `http://localhost:${port}`;

const { stdout, stderr, exit } = process;

function printHelp() {
  stdout.write(`Usage: cock connection list [--cwd PATH] [--all] [--json]

Purpose:  Enumerate all bubbles (terminal + browser) across the running
          Cockpit server. Each entry carries the user-set title if any
          (set via the ✎ button next to the bubble's short id), so an
          LLM can map cryptic 4-char ids to human-meaningful purposes.

Subcommands:
  list                List bubbles (the only subcommand)

Flags:
  --cwd PATH          Only list bubbles whose project cwd matches PATH
                      (canonicalised). Use \$PWD to scope to the
                      current shell.
  --all               Include dead entries (exited terminals,
                      disconnected browsers). Off by default.
  --json              Emit raw JSON instead of TAB-separated lines.

Output (plain, TAB-separated):
  <type> <TAB> <shortId> <TAB> <title-or-(none)> <TAB> <projectCwd-or-?> <TAB> <command-or-empty>

JSON: array of { type, shortId, title?, projectCwd?, tabId?, command?, alive }

Exit: 0=hits, 1=no bubbles, 2=usage, 3=server unreachable

Examples:
  cockpit connection list                     # all alive bubbles
  cockpit connection list --cwd \$PWD         # this project only
  cockpit connection list --all --json | jq   # everything, programmatic
`);
}

if (argv.length === 0 || argv.includes('--help') || argv.includes('-h')) {
  printHelp();
  exit(0);
}

const sub = argv[0];
if (sub !== 'list') {
  stderr.write(`Unknown subcommand: ${sub}\n`);
  stderr.write(`Run \`cockpit connection --help\` to see usage.\n`);
  exit(2);
}

// Parse list-subcommand flags.
const rest = argv.slice(1);
const flags = { cwd: undefined, all: false, json: false };
for (let i = 0; i < rest.length; i++) {
  const tok = rest[i];
  if (tok === '--all') flags.all = true;
  else if (tok === '--json') flags.json = true;
  else if (tok === '--cwd') {
    flags.cwd = rest[++i];
    if (!flags.cwd) {
      stderr.write('Missing value for --cwd\n');
      exit(2);
    }
  } else if (tok === '--help' || tok === '-h') {
    printHelp();
    exit(0);
  } else {
    stderr.write(`Unknown flag: ${tok}\n`);
    exit(2);
  }
}

// Hit the server.
let data;
try {
  const body = {};
  if (flags.cwd) body.cwd = resolve(flags.cwd);
  if (flags.all) body.all = true;
  const res = await fetch(`${baseUrl}/api/connection/list`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const j = await res.json().catch(() => null);
  if (!res.ok || !j?.ok) {
    stderr.write(`HTTP ${res.status}: ${j?.error || 'unknown error'}\n`);
    exit(3);
  }
  data = j.data;
} catch (err) {
  if (err?.cause?.code === 'ECONNREFUSED') {
    stderr.write(`Connection refused: Cockpit server not running at ${baseUrl}\n`);
  } else {
    stderr.write(`Error: ${err.message}\n`);
  }
  exit(3);
}

if (!Array.isArray(data) || data.length === 0) {
  // Empty list — exit 1 so callers can short-circuit cleanly.
  exit(1);
}

if (flags.json) {
  stdout.write(JSON.stringify({ connections: data }, null, 2) + '\n');
  exit(0);
}

// Plain text: TAB-separated, one line per bubble.
//   <type>  <shortId>  <title>  <projectCwd>  <command-or-empty>
const TYPE_LABEL = { terminal: 'term', browser: 'brow' };
for (const c of data) {
  const type = TYPE_LABEL[c.type] || c.type;
  const title = c.title || '(none)';
  const cwd = c.projectCwd || '?';
  const command = (c.command || '').replace(/\s+/g, ' ').slice(0, 120);
  stdout.write(`${type}\t${c.shortId}\t${title}\t${cwd}\t${command}\n`);
}
exit(0);
