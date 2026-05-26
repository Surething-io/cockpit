#!/usr/bin/env node

/**
 * cockpit terminal — read-only analysis CLI for running terminal bubbles.
 *
 * 4 subcommands (read-only by design; write side belongs to Bash tool / web UI):
 *
 *   cock terminal list                     Discover terminals
 *   cock terminal <id> [--json]            Status / meta
 *   cock terminal <id> output [flags]      Read + filter + global lineno
 *   cock terminal <id> wait <mode> [flags] Wait for pattern / idle / exit
 *
 * The CLI is a thin HTTP wrapper. All filtering, lineno bookkeeping, and
 * waiting happens on the server (see packages/feature/console/server/terminal).
 *
 * Global line numbers (`--since N`, `--around N`, `next` in JSON envelopes)
 * are MONOTONIC across the terminal's lifetime — they do not shift when the
 * server's ring buffer trims older lines. `firstAvailable` tells you the
 * smallest line still reachable; `truncated:true` tells you your cursor or
 * window fell partly outside the live buffer.
 */

import { readFileSync } from 'fs';
import { join } from 'path';
import { homedir } from 'os';

const args = process.argv.slice(2);

/* ───────────────────────────────────────────────────────────────────────── */
/* Bootstrap                                                                 */
/* ───────────────────────────────────────────────────────────────────────── */

function readServerPort() {
  try {
    return JSON.parse(readFileSync(join(homedir(), '.cockpit', 'server.json'), 'utf8')).port;
  } catch {
    return null;
  }
}

const port = process.env.COCKPIT_PORT || readServerPort() || 3457;
const baseUrl = `http://localhost:${port}`;

async function post(path, body, timeoutMs = 10000) {
  try {
    const res = await fetch(`${baseUrl}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body || {}),
      signal: AbortSignal.timeout(timeoutMs),
    });
    const data = await res.json().catch(() => null);
    if (!res.ok || !data?.ok) {
      const msg = data?.error || `HTTP ${res.status}`;
      throw new Error(msg);
    }
    return data.data;
  } catch (err) {
    if (err.cause?.code === 'ECONNREFUSED') {
      console.error(`Connection refused: Cockpit server not running at ${baseUrl}`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Flag parsing — minimal, no dependency                                     */
/* ───────────────────────────────────────────────────────────────────────── */

/**
 * Parse `argv` looking for flags described by `spec`. Returns
 * `{flags, positional}`. Flags accept:
 *   - boolean (no value)
 *   - 'string' / 'number' (takes the next argv as value)
 *
 * Unknown flags fail loudly so typos surface.
 */
function parseFlags(argv, spec) {
  const flags = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i];
    if (!tok.startsWith('--')) {
      positional.push(tok);
      continue;
    }
    const name = tok.slice(2);
    if (!(name in spec)) {
      console.error(`Unknown flag: --${name}`);
      process.exit(2);
    }
    const type = spec[name];
    if (type === 'boolean') {
      flags[name] = true;
    } else {
      const val = argv[++i];
      if (val === undefined) {
        console.error(`Missing value for --${name}`);
        process.exit(2);
      }
      flags[name] = type === 'number' ? Number(val) : val;
      if (type === 'number' && Number.isNaN(flags[name])) {
        console.error(`--${name} requires a number, got "${val}"`);
        process.exit(2);
      }
    }
  }
  return { flags, positional };
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Top-level help                                                            */
/* ───────────────────────────────────────────────────────────────────────── */

function printTopHelp() {
  console.log(`Analyse output of long-running terminal bubbles inside Cockpit.

This CLI is READ-ONLY by design — the write side (stdin, signals, kill) is
covered by the Bash tool (spawn your own process) or the Cockpit web UI
(human types into the bubble). cock terminal only reads, filters, and waits.

Usage: cockpit terminal <id> <action> [flags]
       cockpit terminal list

Subcommands:
  list                        List all terminals (use --json for structured)
  <id>                        Show terminal status + FULL action cheat sheet
                              ← start here when you don't know what flags exist
  <id> output [flags]         Read buffered output (filter / context / cursor)
  <id> wait <mode> [flags]    Block until pattern / idle / exit / timeout

For specific flag docs:
  cockpit terminal <id>                    show all flags for this terminal
  cockpit terminal <id> output --help      output flags
  cockpit terminal <id> wait --help        wait flags

Quick orientation if you don't have an id yet:
  cockpit terminal list                    → pick a shortId from the list
  cockpit terminal <shortId>               → see status + full cheat sheet`);
}

/* ───────────────────────────────────────────────────────────────────────── */
/* list                                                                      */
/* ───────────────────────────────────────────────────────────────────────── */

async function cmdList(rest) {
  const { flags } = parseFlags(rest, { json: 'boolean' });
  const list = await post('/api/terminal/list', {});
  if (flags.json) {
    process.stdout.write(JSON.stringify({ terminals: list }) + '\n');
    return;
  }
  if (list.length === 0) {
    console.log('No running terminals');
    return;
  }
  for (const t of list) {
    const dot = t.running ? '●' : '○';
    const ptyTag = t.usePty ? ' [pty]' : '';
    console.log(`${dot} ${t.shortId}  ${t.running ? 'running' : 'stopped'}${ptyTag}  ${t.command}`);
  }
  // Hint AI to the next step. The cheat sheet on the meta page is the real
  // entry point — list alone doesn't tell you how to act on any of these ids.
  console.log('');
  console.log(`Next: cock terminal <shortId>   (status + full action cheat sheet)`);
}

/* ───────────────────────────────────────────────────────────────────────── */
/* <id> meta                                                                 */
/* ───────────────────────────────────────────────────────────────────────── */

function formatRelative(iso) {
  if (!iso) return 'never';
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 1000) return 'just now';
  if (ms < 60000) return `${Math.floor(ms / 1000)}s ago`;
  if (ms < 3600000) return `${Math.floor(ms / 60000)}m ago`;
  return `${Math.floor(ms / 3600000)}h ago`;
}

/**
 * Cheat sheet rendered into the `<id>` meta output. AI agents have no memory
 * between tool calls — this is their entry point and must self-describe the
 * full surface area. Includes a copy-pasteable workflow section keyed off
 * the actual id so the agent can use it without templating.
 */
function actionsCheatSheet(id) {
  return `Available actions:

  cock terminal ${id} output [flags]      Read buffered output (filter + global lineno)
  cock terminal ${id} wait <mode> [flags] Block until pattern / idle / exit / timeout

Output — read mode (pick one, default = entire buffer):
  --since <N>         Continue from global line number N (cursor from previous call).
                      Line numbers are MONOTONIC and stable across ring buffer trims.
  --tail <N>          Last N complete lines
  --head <N>          First N complete lines still in the ring
  --around <N>        Window around global line N (use with --context)
  --context <K>       Context size for --around (default 5)

Output — filtering / display:
  --grep <regex>      Server-side regex over each line (post-strip)
  --ignore-case, -i   Case-insensitive grep
  --no-ansi/--keep-ansi              Strip ANSI control sequences (default: on)
  --collapse-cr/--keep-cr            Fold \\r overwrites within line (default: on)
  --with-lineno/--no-prefix          Lineno prefix (grep/around default: on)
  --max-bytes <N>     Cap response body (default 65536; trims oldest first)
  --json              JSON envelope on stdout

Output raw format:
  stdout = lines (each prefixed with "<lineno>: " in grep/around modes)
  stderr last line = {"next":N,"firstAvailable":M,"totalLines":T,"truncated":bool,"running":bool,"matched":K}
  Use the "next" value as --since for the next call to read only new output.

Wait — pick exactly one mode:
  --pattern <regex>   Wait until an output line matches (does NOT scan history,
                      only new output after this call)
  --idle <s>          Wait until s seconds elapse with no new output
  --exit              Wait until command exits
  --timeout <s>       Total deadline in seconds (default 30)
  --print             Echo received output to stdout
  --json              JSON envelope

Wait exit codes: 0=condition met, 124=timeout (GNU convention), 2=bad usage, 1=other.

Common workflows:
  # Find error candidates with global line numbers
  cock terminal ${id} output --grep error -i

  # Inspect 15 lines around line 4920
  cock terminal ${id} output --around 4920 --context 15

  # Incremental read — pass 'next' from previous call's stderr
  cock terminal ${id} output --since 5100

  # Wait until build settles (3s idle)
  cock terminal ${id} wait --idle 3 --timeout 60

  # Wait until dev server announces ready
  cock terminal ${id} wait --pattern 'Ready in' --timeout 90 --print

  # Programmatic — both stdout/stderr fields available in one JSON
  cock terminal ${id} output --tail 50 --json | jq .`;
}

async function cmdMeta(id, rest) {
  // `<id> --help` / `<id> -h` is the same as `<id>` itself — the meta page
  // already IS the cheat sheet for that bubble (it lists every available
  // action). Strip the flag here so parseFlags doesn't reject it as
  // "Unknown flag: --help".
  rest = rest.filter((a) => a !== '--help' && a !== '-h');
  const { flags } = parseFlags(rest, { json: 'boolean' });
  const meta = await post('/api/terminal/meta', { id });
  if (flags.json) {
    process.stdout.write(JSON.stringify(meta) + '\n');
    return;
  }
  const mode = meta.usePty ? 'pty' : 'pipe';
  if (meta.running) {
    console.log(`Terminal ${meta.shortId} (running, ${mode})`);
    console.log(`  command:      ${meta.command}`);
    console.log(`  pid:          ${meta.pid}`);
    if (meta.cwd) console.log(`  cwd:          ${meta.cwd}`);
    console.log(`  started:      ${formatRelative(meta.startedAt)}`);
    console.log(`  last output:  ${formatRelative(meta.lastOutputAt)}`);
    const truncTag =
      meta.firstAvailable > 0
        ? ` (truncated, first available line ${meta.firstAvailable})`
        : '';
    console.log(`  output:       ${meta.totalLines} lines${truncTag}`);
    console.log('');
    console.log(actionsCheatSheet(meta.shortId));
  } else {
    console.log(`Terminal ${meta.shortId} (stopped)`);
    console.log(`  command:      ${meta.command}`);
    console.log('');
    console.log('Output of stopped terminals is read from JSONL history; live cursor/grep/wait do not apply.');
  }
}

/* ───────────────────────────────────────────────────────────────────────── */
/* <id> output                                                               */
/* ───────────────────────────────────────────────────────────────────────── */

const OUTPUT_FLAG_SPEC = {
  // read mode (mutually exclusive)
  since: 'number',
  tail: 'number',
  head: 'number',
  around: 'number',
  context: 'number',
  // filtering
  grep: 'string',
  ['ignore-case']: 'boolean',
  i: 'boolean', // alias for ignore-case
  // display
  ['no-ansi']: 'boolean',
  ['keep-ansi']: 'boolean',
  ['collapse-cr']: 'boolean',
  ['keep-cr']: 'boolean',
  ['with-lineno']: 'boolean',
  ['no-prefix']: 'boolean',
  ['max-bytes']: 'number',
  json: 'boolean',
};

function printOutputHelp() {
  console.log(`Usage: cock terminal <id> output [flags]

Read modes (pick one, default = entire buffer):
  --since <N>         Continue from global line number N (cursor)
  --tail <N>          Last N complete lines
  --head <N>          First N complete lines still in the ring
  --around <N>        Lines around global line N (use with --context)
  --context <K>       Context size for --around (default 5)

Filtering:
  --grep <regex>      Server-side regex over each line (post-strip)
  --ignore-case, -i   Case-insensitive grep
  --since <N>         May be combined with --grep to bound scan

Display:
  --no-ansi           Strip ANSI control sequences (default: on; --keep-ansi to disable)
  --keep-ansi         Force-keep ANSI
  --collapse-cr       Fold \\r-overwrites within each line (default: on; --keep-cr to disable)
  --keep-cr           Force-keep \\r
  --with-lineno       Prefix each line with "<lineno>: "
  --no-prefix         Force no lineno prefix
  --max-bytes <N>     Cap response body (default 65536; trims oldest first)
  --json              Return JSON envelope on stdout

Default prefix behaviour:
  --grep / --around   prefix on
  --since/--tail/--head  prefix off
`);
}

async function cmdOutput(id, rest) {
  if (rest.includes('--help') || rest.includes('-h')) {
    printOutputHelp();
    return;
  }
  const { flags } = parseFlags(rest, OUTPUT_FLAG_SPEC);

  // Reconcile keep- / no- conflicts (later flag wins).
  const ansiFlag =
    flags['keep-ansi'] ? false : flags['no-ansi'] ? true : undefined;
  const crFlag =
    flags['keep-cr'] ? false : flags['collapse-cr'] ? true : undefined;

  const body = {
    id,
    ...(typeof flags.since === 'number' ? { since: flags.since } : {}),
    ...(typeof flags.tail === 'number' ? { tail: flags.tail } : {}),
    ...(typeof flags.head === 'number' ? { head: flags.head } : {}),
    ...(typeof flags.around === 'number' ? { around: flags.around } : {}),
    ...(typeof flags.context === 'number' ? { context: flags.context } : {}),
    ...(flags.grep ? { grep: flags.grep } : {}),
    ...(flags['ignore-case'] || flags.i ? { ignoreCase: true } : {}),
    ...(ansiFlag !== undefined ? { noAnsi: ansiFlag } : {}),
    ...(crFlag !== undefined ? { collapseCr: crFlag } : {}),
    ...(typeof flags['max-bytes'] === 'number'
      ? { maxBytes: flags['max-bytes'] }
      : {}),
  };

  const data = await post('/api/terminal/output', body, 30000);

  if (flags.json) {
    process.stdout.write(JSON.stringify(data) + '\n');
    return;
  }

  // Default prefix: on for grep/around, off otherwise. Explicit
  // --with-lineno / --no-prefix override.
  const grepOrAround = !!flags.grep || typeof flags.around === 'number';
  let withLineno = grepOrAround;
  if (flags['with-lineno']) withLineno = true;
  if (flags['no-prefix']) withLineno = false;

  for (const m of data.matches) {
    if (withLineno) {
      process.stdout.write(`${m.lineno}: ${m.text}\n`);
    } else {
      process.stdout.write(`${m.text}\n`);
    }
  }

  // Idle interactive prompt heuristic: when a PTY terminal hasn't run any
  // command, its buffer is dominated by zsh prompt redraws (`\r\x1b[K…`).
  // After strip-ansi + collapse-cr these collapse to empty strings, so the
  // user sees blank lines and may think the call is broken. Tell them.
  if (
    data.matches.length > 0 &&
    data.matches.every((m) => m.text === '')
  ) {
    process.stderr.write(
      `(${data.matches.length} lines returned, all empty after strip-ansi + ` +
      `collapse-cr — likely an idle interactive shell. ` +
      `Use --keep-ansi --keep-cr to see raw bytes, ` +
      `or wait for actual command output.)\n`,
    );
  }

  // Cursor + truncation info on stderr so AI can pipe stdout cleanly.
  const meta = {
    next: data.next,
    firstAvailable: data.firstAvailable,
    totalLines: data.totalLines,
    truncated: data.truncated,
    running: data.running,
    matched: data.matches.length,
  };
  process.stderr.write(JSON.stringify(meta) + '\n');
}

/* ───────────────────────────────────────────────────────────────────────── */
/* <id> wait                                                                 */
/* ───────────────────────────────────────────────────────────────────────── */

const WAIT_FLAG_SPEC = {
  pattern: 'string',
  idle: 'number',
  exit: 'boolean',
  timeout: 'number',
  print: 'boolean',
  json: 'boolean',
};

function printWaitHelp() {
  console.log(`Usage: cock terminal <id> wait [flags]

Modes (exactly one):
  --pattern <regex>   Wait until output line matches regex
  --idle <s>          Wait until s seconds elapse without new output
  --exit              Wait until the command exits

Common:
  --timeout <s>       Total deadline (default 30s)
  --print             Echo received output to stdout (only meaningful for --pattern / --idle)
  --json              JSON envelope instead of text

Exit codes:
  0    condition satisfied
  124  timeout (GNU \`timeout\` convention)
  2    bad usage
  1    other error
`);
}

async function cmdWait(id, rest) {
  if (rest.includes('--help') || rest.includes('-h')) {
    printWaitHelp();
    return;
  }
  const { flags } = parseFlags(rest, WAIT_FLAG_SPEC);
  const modeCount =
    (flags.pattern ? 1 : 0) +
    (typeof flags.idle === 'number' ? 1 : 0) +
    (flags.exit ? 1 : 0);
  if (modeCount !== 1) {
    console.error('wait requires exactly one of --pattern / --idle / --exit');
    process.exit(2);
  }

  const timeoutSec = typeof flags.timeout === 'number' ? flags.timeout : 30;
  const body = {
    id,
    timeout: timeoutSec,
    ...(flags.pattern ? { pattern: flags.pattern } : {}),
    ...(typeof flags.idle === 'number' ? { idle: flags.idle } : {}),
    ...(flags.exit ? { waitExit: true } : {}),
    ...(flags.print ? { printOutput: true } : {}),
  };
  // Allow the HTTP socket a bit longer than the server-side deadline so we
  // don't race the server's `outcome:"timeout"` response.
  const data = await post('/api/terminal/wait', body, (timeoutSec + 5) * 1000);

  if (flags.json) {
    process.stdout.write(JSON.stringify(data) + '\n');
  } else {
    if (data.output) process.stdout.write(data.output);
    process.stderr.write(JSON.stringify(data) + '\n');
  }
  process.exit(data.outcome === 'timeout' ? 124 : 0);
}

/* ───────────────────────────────────────────────────────────────────────── */
/* Top-level dispatch                                                        */
/* ───────────────────────────────────────────────────────────────────────── */

async function run() {
  if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
    printTopHelp();
    return;
  }

  // list is the only id-less subcommand.
  if (args[0] === 'list') {
    await cmdList(args.slice(1));
    return;
  }

  const id = args[0];
  const action = args[1];
  const rest = args.slice(2);

  if (!action || action === '--help' || action === '-h' || action === '--json') {
    // `cock terminal <id>` or `cock terminal <id> --json` → meta
    const extras = action ? [action, ...rest] : rest;
    await cmdMeta(id, extras);
    return;
  }

  if (action === 'output') {
    await cmdOutput(id, rest);
    return;
  }

  if (action === 'wait') {
    await cmdWait(id, rest);
    return;
  }

  console.error(`Unknown action: ${action}`);
  printTopHelp();
  process.exit(2);
}

export const done = run();
