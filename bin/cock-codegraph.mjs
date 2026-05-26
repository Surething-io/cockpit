#!/usr/bin/env node
/**
 * cock codegraph — unified CLI for all 10 /api/projectGraph/* endpoints.
 *
 * Usage:
 *   cock codegraph                         List subcommands
 *   cock codegraph <sub> --help            Per-subcommand help
 *   cock codegraph <sub> ... [--json]      All subcommands accept --json
 *
 * Subcommands map 1:1 to HTTP endpoints; the CLI is a thin shim that
 * shares the running server's live CodeIndex (no per-invocation parse).
 *
 * Exit codes:
 *   0  output produced
 *   1  empty result (e.g. no callers; lets shell pipelines short-circuit)
 *   2  argument / usage / 4xx server error
 *   3  Cockpit server not reachable on COCKPIT_PORT (default 3457)
 */
import { argv, cwd, exit, stderr, stdin, stdout, env } from 'node:process';

const PORT = env.COCKPIT_PORT || '3457';
const HOST = env.COCKPIT_HOST || 'localhost';
const BASE = `http://${HOST}:${PORT}`;

const SUBCMDS = [
  'search', 'callers', 'callees', 'impact', 'file', 'coedit',
  'context', 'related', 'risk', 'affected',
];

const sub = argv[2];

if (!sub || sub === '-h' || sub === '--help') {
  printTopHelp();
  exit(0);
}

if (!SUBCMDS.includes(sub)) {
  stderr.write(`cock codegraph: unknown subcommand "${sub}"\n`);
  stderr.write(`Available: ${SUBCMDS.join(', ')}\n`);
  exit(2);
}

// Per-subcommand args are everything after the subcommand name.
const subArgs = argv.slice(3);

// Common flag: --json / --help.
const wantJson = subArgs.includes('--json');
const wantHelp = subArgs.includes('--help') || subArgs.includes('-h');

if (wantHelp) {
  printSubHelp(sub);
  exit(0);
}

// Dispatch.
try {
  switch (sub) {
    case 'search':   await cmdSearch(); break;
    case 'callers':  await cmdCallers(); break;
    case 'callees':  await cmdCallees(); break;
    case 'impact':   await cmdImpact(); break;
    case 'file':     await cmdFile(); break;
    case 'coedit':   await cmdCoedit(); break;
    case 'context':  await cmdContext(); break;
    case 'related':  await cmdRelated(); break;
    case 'risk':     await cmdRisk(); break;
    case 'affected': await cmdAffected(); break;
  }
} catch (err) {
  stderr.write(`codegraph ${sub}: ${err?.message || err}\n`);
  exit(2);
}

// ============================================================================
// HTTP helpers
// ============================================================================

async function get(path, params) {
  const url = new URL(`${BASE}${path}`);
  url.searchParams.set('cwd', cwd());
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    url.searchParams.set(k, String(v));
  }
  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    stderr.write(
      `codegraph: cannot reach Cockpit at ${BASE}\n` +
        `        (${err?.code ?? err?.name ?? 'fetch failed'})\n` +
        `        Start it with: cock\n`,
    );
    exit(3);
  }
  if (!resp.ok) {
    const text = await resp.text();
    stderr.write(`codegraph: server returned ${resp.status}\n${text}\n`);
    exit(2);
  }
  return resp;
}

async function post(path, body) {
  let resp;
  try {
    resp = await fetch(`${BASE}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
  } catch (err) {
    stderr.write(
      `codegraph: cannot reach Cockpit at ${BASE}\n` +
        `        (${err?.code ?? err?.name ?? 'fetch failed'})\n` +
        `        Start it with: cock\n`,
    );
    exit(3);
  }
  if (!resp.ok) {
    const text = await resp.text();
    stderr.write(`codegraph: server returned ${resp.status}\n${text}\n`);
    exit(2);
  }
  return resp;
}

// ============================================================================
// Tiny arg parser — pulls --flag values without depending on yargs etc.
// ============================================================================

function getFlag(args, name) {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  if (v === undefined || v.startsWith('-')) return undefined;
  return v;
}

function getInt(args, name) {
  const v = getFlag(args, name);
  if (v === undefined) return undefined;
  const n = parseInt(v, 10);
  if (!Number.isFinite(n)) {
    stderr.write(`${name} requires a number, got "${v}"\n`);
    exit(2);
  }
  return n;
}

function positional(args) {
  return args.filter((a, i) => {
    if (a.startsWith('-')) return false;
    const prev = args[i - 1];
    // Skip values that follow a known flag-with-value.
    const flagsWithValue = new Set([
      '--file', '--depth', '--top', '--limit', '--commits',
      '--query', '--cursor', '--open', '--filter', '--include',
    ]);
    if (prev && flagsWithValue.has(prev)) return false;
    return true;
  });
}

async function readStdinLines() {
  let buf = '';
  stdin.setEncoding('utf8');
  for await (const chunk of stdin) buf += chunk;
  return buf.split('\n').map((s) => s.trim()).filter(Boolean);
}

function emitJson(obj) {
  stdout.write(JSON.stringify(obj, null, 2) + '\n');
}

// ============================================================================
// search
// ============================================================================

async function cmdSearch() {
  const pos = positional(subArgs);
  const q = pos[0];
  const limit = getInt(subArgs, '--limit') ?? 15;
  if (!q) {
    stderr.write('codegraph search: missing <query>\n');
    exit(2);
  }
  const resp = await get('/api/projectGraph/search', { q, limit });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  const files = data.files || [];
  const syms = data.symbols || [];
  if (files.length === 0 && syms.length === 0) exit(1);

  for (const f of files) {
    stdout.write(`file\t${f.target?.filePath ?? f.label}\n`);
  }
  for (const s of syms) {
    const t = s.target;
    stdout.write(`sym \t${t.filePath}:${t.line}\t${t.symbolKind}\t${t.qualifiedName}\n`);
  }
  exit(0);
}

// ============================================================================
// callers / callees (shared shape)
// ============================================================================

async function cmdCallers() { await runCallSide('callers'); }
async function cmdCallees() { await runCallSide('callees'); }

async function runCallSide(kind) {
  const pos = positional(subArgs);
  const qname = pos[0];
  const filePath = getFlag(subArgs, '--file');
  if (!qname) {
    stderr.write(`codegraph ${kind}: missing <qname>\n`);
    exit(2);
  }
  const resp = await get(`/api/projectGraph/${kind}`, { qname, filePath });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  const list = data[kind] || [];
  if (data.ambiguousIn) {
    stderr.write(`# ambiguousIn: ${data.ambiguousIn.join(', ')} — pass --file to disambiguate\n`);
  }
  if (list.length === 0) exit(1);
  for (const item of list) {
    const node = item.caller || item.callee;
    const lines = (item.callLines || []).join(',');
    stdout.write(`${node.filePath}:${node.startLine}\t${node.qualifiedName}\t[${lines}]\n`);
  }
  exit(0);
}

// ============================================================================
// impact
// ============================================================================

async function cmdImpact() {
  const pos = positional(subArgs);
  const qname = pos[0];
  const filePath = getFlag(subArgs, '--file');
  const depth = getInt(subArgs, '--depth') ?? 2;
  if (!qname) {
    stderr.write('codegraph impact: missing <qname>\n');
    exit(2);
  }
  const resp = await get('/api/projectGraph/impact', { qname, filePath, depth });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  const nodes = data.nodes || [];
  if (data.truncated) {
    stderr.write(`# impact truncated at server cap (500). Use 'risk' for ranked + bounded output.\n`);
  }
  if (nodes.length === 0) exit(1);
  for (const n of nodes) {
    const s = n.symbol;
    stdout.write(`d=${n.depth}\t${s.filePath}:${s.startLine}\t${s.qualifiedName}\n`);
  }
  exit(0);
}

// ============================================================================
// file
// ============================================================================

async function cmdFile() {
  const pos = positional(subArgs);
  const path = pos[0];
  if (!path) {
    stderr.write('codegraph file: missing <path>\n');
    exit(2);
  }
  const resp = await get('/api/projectGraph/file', { path });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  const syms = data.symbols || [];
  if (syms.length === 0) exit(1);
  for (const s of syms) {
    stdout.write(`${s.kind}\t${s.startLine}-${s.endLine}\t${s.qualifiedName}\n`);
  }
  exit(0);
}

// ============================================================================
// coedit
// ============================================================================

async function cmdCoedit() {
  const pos = positional(subArgs);
  const filePath = pos[0];
  const commits = getInt(subArgs, '--commits') ?? 100;
  if (!filePath) {
    stderr.write('codegraph coedit: missing <path>\n');
    exit(2);
  }
  const resp = await get('/api/projectGraph/coedit', { filePath, commits });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  const history = data.history || [];
  const uncommitted = data.uncommitted || [];
  if (history.length === 0 && uncommitted.length === 0) {
    stderr.write(`# no cooccurrence (totalCommits=${data.totalCommits})\n`);
    exit(1);
  }
  if (history.length > 0) {
    stdout.write(`# history (cooccurrence/total)\n`);
    for (const h of history) {
      stdout.write(`${h.cooccurrence}/${data.totalCommits}\t${h.file}\n`);
    }
  }
  if (uncommitted.length > 0) {
    stdout.write(`# uncommitted (working tree)\n`);
    for (const f of uncommitted) stdout.write(`-\t${f}\n`);
  }
  exit(0);
}

// ============================================================================
// context
// ============================================================================

async function cmdContext() {
  const query = getFlag(subArgs, '--query');
  const cursor = getFlag(subArgs, '--cursor');
  const openFiles = getFlag(subArgs, '--open');
  const top = getInt(subArgs, '--top') ?? 15;
  if (!query && !cursor && !openFiles) {
    stderr.write('codegraph context: need at least one of --query / --cursor / --open\n');
    exit(2);
  }
  const resp = await get('/api/projectGraph/context', {
    query, cursor, openFiles, topK: top,
  });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  if (data.cursorResolution && !data.cursorResolution.matched) {
    stderr.write(`# cursor not matched: ${data.cursorResolution.notes || '(no note)'}\n`);
  } else if (data.cursorResolution?.notes) {
    stderr.write(`# cursor: ${data.cursorResolution.notes}\n`);
  }
  if (data.degraded) {
    stderr.write(`# degraded: ${data.degradedReason}\n`);
  }
  const results = data.results || [];
  if (results.length === 0) exit(1);
  for (const r of results) {
    const sigs = (r.signals || []).map((s) => s.type).join(',');
    stdout.write(`${r.score.toFixed(2)}\t${r.filePath}:${r.startLine}\t${r.qualifiedName}\t[${sigs}]\n`);
  }
  exit(0);
}

// ============================================================================
// related
// ============================================================================

async function cmdRelated() {
  const pos = positional(subArgs);
  const qname = pos[0];
  const filePath = getFlag(subArgs, '--file');
  const top = getInt(subArgs, '--top') ?? 10;
  const include = getFlag(subArgs, '--include') ?? 'all';
  if (!qname) {
    stderr.write('codegraph related: missing <qname>\n');
    exit(2);
  }
  const resp = await get('/api/projectGraph/related', {
    qname, filePath, topK: top, include,
  });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  if (data.ambiguousIn) {
    stderr.write(`# ambiguousIn: ${data.ambiguousIn.join(', ')} — pass --file to disambiguate\n`);
  }
  if (data.degraded) stderr.write(`# degraded: ${data.degradedReason}\n`);
  const results = data.results || [];
  if (results.length === 0) exit(1);
  for (const r of results) {
    const rels = (r.relations || []).map((x) => x.type).join(',');
    stdout.write(`${r.score.toFixed(2)}\t${r.filePath}:${r.startLine}\t${r.qualifiedName}\t<${rels}>\n`);
  }
  exit(0);
}

// ============================================================================
// risk
// ============================================================================

async function cmdRisk() {
  const pos = positional(subArgs);
  const qname = pos[0];
  const filePath = getFlag(subArgs, '--file');
  const depth = getInt(subArgs, '--depth') ?? 2;
  const top = getInt(subArgs, '--top') ?? 20;
  if (!qname) {
    stderr.write('codegraph risk: missing <qname>\n');
    exit(2);
  }
  const resp = await get('/api/projectGraph/risk', {
    qname, filePath, depth, topK: top,
  });
  const data = await resp.json();
  if (wantJson) { emitJson(data); exit(0); }

  if (data.degraded) stderr.write(`# degraded: ${data.degradedReason}\n`);
  const highRisk = data.highRisk || [];
  if (highRisk.length === 0 && !data.target) exit(1);

  stdout.write(`# total impacted: ${data.totalImpactedNodes}\n`);
  for (const n of highRisk) {
    const tags = (n.tags || []).join(',') || '-';
    stdout.write(`${n.risk.score.toFixed(3)}\td=${n.depth}\t${n.filePath}:${n.startLine}\t${n.qualifiedName}\t[${tags}]\n`);
  }
  const tests = data.suggestedTests || [];
  if (tests.length > 0) {
    stdout.write(`\n# suggestedTests\n`);
    for (const t of tests) {
      const covered = (t.coveredNodes || []).slice(0, 3).join(', ');
      stdout.write(`${t.reason}\t${t.filePath}\t(${covered}${t.coveredNodes?.length > 3 ? ',…' : ''})\n`);
    }
  }
  exit(0);
}

// ============================================================================
// affected — inherits the original cock-affected.mjs behaviour
// ============================================================================

async function cmdAffected() {
  // Affected is special: accepts file list via positional or --stdin, and
  // has dedicated text modes (--as-cmd / --json / plain).
  //
  // --as-cmd is intentionally generic (not --as-jest etc.) because:
  //   - test runners differ across project ecosystems (jest, vitest, bun
  //     test, playwright test, pytest, go test, cargo test, ...)
  //   - our isTestFile() already detects test files for JS/TS/Python/Go/Rust
  //   - hardcoding `jest` here would mis-format outputs in any non-Jest
  //     project, while still claiming the files are runnable.
  // The user passes whatever shell prefix matches their setup.
  let useStdin = false;
  let asCmd; // string runner prefix (e.g. "jest", "vitest run", "pytest -v")
  let includeAll = false;
  const files = [];
  let depth = 10;
  let filter;
  for (let i = 0; i < subArgs.length; i++) {
    const a = subArgs[i];
    if (a === '--stdin') useStdin = true;
    else if (a === '--as-cmd') {
      asCmd = subArgs[++i];
      if (!asCmd) {
        stderr.write('codegraph affected: --as-cmd requires a runner string (e.g. "jest", "vitest run", "pytest -v")\n');
        exit(2);
      }
    }
    else if (a === '--include-all') includeAll = true;
    else if (a === '--json') { /* already handled */ }
    else if (a === '--depth') { depth = parseInt(subArgs[++i], 10) || depth; }
    else if (a === '--filter') { filter = subArgs[++i]; }
    else if (a.startsWith('-')) {
      stderr.write(`codegraph affected: unknown flag "${a}"\n`);
      exit(2);
    } else {
      files.push(a);
    }
  }

  if (useStdin) {
    const lines = await readStdinLines();
    files.push(...lines);
  }
  if (files.length === 0) {
    stderr.write('codegraph affected: no files provided (pass file args or use --stdin)\n');
    exit(2);
  }

  const payload = {
    cwd: cwd(),
    files,
    depth,
    filter,
    includeAll,
    format: wantJson ? 'json' : 'plain',
  };
  const resp = await post('/api/projectGraph/affected', payload);

  if (wantJson) {
    const data = await resp.json();
    stdout.write(JSON.stringify(data, null, 2) + '\n');
    exit(data?.testFiles?.length > 0 ? 0 : 1);
  }

  const unresolvedHdr = parseInt(resp.headers.get('x-unresolved-count') ?? '0', 10) || 0;
  const truncated = resp.headers.get('x-truncated') === 'true';
  const text = await resp.text();
  const paths = text.split('\n').map((l) => l.trim()).filter(Boolean);

  if (unresolvedHdr > 0) {
    stderr.write(
      `codegraph affected: ${unresolvedHdr} input file(s) not found in CodeIndex (deleted, generated, or unsupported language)\n`,
    );
  }
  if (truncated) {
    stderr.write(
      `codegraph affected: BFS hit node cap — results may miss deeper tests\n`,
    );
  }

  if (asCmd) {
    if (paths.length === 0) {
      stderr.write('codegraph affected: no test files — nothing to run\n');
      exit(1);
    }
    stdout.write(`${asCmd} ${paths.map((p) => JSON.stringify(p)).join(' ')}\n`);
    exit(0);
  }
  if (paths.length === 0) exit(1);
  stdout.write(paths.join('\n') + '\n');
  exit(0);
}

// ============================================================================
// Help text
// ============================================================================

function printTopHelp() {
  stdout.write(`Usage: cock codegraph <subcommand> [options]

Lookups (mirror existing /api/projectGraph/* endpoints — coordinates only):
  search   <query>                       Find symbols by name (file + qname hits)
  callers  <qname> [--file PATH]         Direct callers of a symbol
  callees  <qname> [--file PATH]         What a symbol calls
  impact   <qname> [--depth N=2]         Transitive callers BFS (use 'risk' for ranked output)
  file     <path>                        Symbol tree of a file
  coedit   <path> [--commits N=100]      Files co-edited in git history

Analytics (PPR / TF-IDF / Louvain / coedit blended):
  context  --query Q [--cursor C] [--open F1,F2,...]
           [--top N=15]                  Top-K semantically relevant coordinates
  related  <qname> [--file PATH]
           [--top N=10]                  Broader neighbours: caller/callee + ppr + coedit + community
  risk     <qname> [--depth N=2] [--top N=20]
                                         Risk-scored impact + suggestedTests
  affected <files…|--stdin>
           [--depth N=10] [--filter G]
           [--as-cmd RUNNER]              Test files transitively affected (CI / xargs)
           [--include-all]

Common flags (all subcommands):
  --json             Emit raw JSON response (full schema; see per-cmd --help)
  --help, -h         Subcommand-specific help (output format + exit codes + examples)

Plain output format (TAB-separated, one row per result):
  search    sym\\t<file>:<line>\\t<kind>\\t<qname>            or  file\\t<file>
  callers   <file>:<line>\\t<qname>\\t[<callLines>]
  callees   <file>:<line>\\t<qname>\\t[<callLines>]
  impact    d=<depth>\\t<file>:<line>\\t<qname>
  file      <kind>\\t<startLine>-<endLine>\\t<qname>
  coedit    <cooccur>/<total>\\t<file>               (after '# history' comment)
  context   <score>\\t<file>:<line>\\t<qname>\\t[<signals>]
  related   <score>\\t<file>:<line>\\t<qname>\\t<<relations>>
  risk      <score>\\td=<depth>\\t<file>:<line>\\t<qname>\\t[<tags>]
  affected  <file>                                  (one test path per line)

Diagnostics on stderr (don't break shell pipelines):
  # ambiguousIn: <files…>     Same qname in multiple files — pass --file
  # cursor: <note>            Cursor format auto-corrected ('.' → '::', etc.)
  # degraded: <reason>        analytics-warming / coedit-unavailable / truncated

Exit codes:
  0  output produced
  1  empty result (no callers / no tests / no hits) — short-circuit shell pipelines
  2  argument or 4xx server error
  3  Cockpit server not reachable (start it: cock <project-path>)

Prerequisites:
  Cockpit server running at ${BASE}
  (override host/port: COCKPIT_HOST, COCKPIT_PORT)

Examples:
  cock codegraph search getCodeIndex
  cock codegraph related getCodeIndex --top 5
  cock codegraph risk handleSlackMention --depth 2
  git diff --name-only | cock codegraph affected --stdin                       # → newline test paths
  git diff --name-only | cock codegraph affected --stdin --as-cmd jest         # → jest "a" "b" …
  git diff --name-only | cock codegraph affected --stdin --as-cmd "vitest run" # → vitest run "a" "b" …
`);
}

/**
 * Per-subcommand help. Each entry follows the SAME shape so an LLM agent
 * scanning the output knows exactly where to find what it needs:
 *
 *   Usage:      <command line>
 *   Purpose:    <one-paragraph what + when>
 *   Flags:      <flag table>
 *   Output:     <TAB-separated row schema for plain mode>
 *   --json:     <top-level JSON keys to expect>
 *   Stderr:     <diagnostic prefixes you might see>
 *   Exit codes: <ints + meaning>
 *   Examples:   <2-4 worked invocations>
 *
 * Self-documenting like `cock terminal <id>` — agents are stateless between
 * tool calls, so the help has to carry everything they need.
 */
// Lazy — exposed via getSubHelp() so the top-level `printSubHelp(sub)`
// call (which runs before this declaration is reached in module order)
// doesn't hit a const TDZ.
function getSubHelp() { return {
  search: `Usage: cock codegraph search <query> [--limit N=15] [--json]

Purpose:  Find symbols (and files) matching a name fragment. Tokenised
          match across name + qualifiedName + filePath. Use this when
          you know the symbol's name but not its location.

Flags:
  --limit N        Max symbol hits to return (default 15)
  --json           Emit raw JSON {files: [...], symbols: [...]}

Output (plain, TAB-separated):
  sym <TAB> <file>:<line> <TAB> <kind> <TAB> <qname>
  file <TAB> <file>

JSON keys: files[].target, symbols[].target.{filePath,line,symbolKind,qualifiedName}

Exit: 0=hits, 1=no hits, 2=usage, 3=server unreachable

Examples:
  cock codegraph search getCodeIndex
  cock codegraph search useChatStore --limit 5
  cock codegraph search authenticate --json | jq '.symbols[].target'`,

  callers: `Usage: cock codegraph callers <qname> [--file PATH] [--json]

Purpose:  Direct callers of <qname> (1-hop). For transitive use 'impact'
          or 'risk'. Pass --file when the qname exists in multiple files
          (response will warn via 'ambiguousIn').

Flags:
  --file PATH      Disambiguate when qname appears in multiple files
  --json           Emit raw JSON {qname, target, callers: [...]}

Output (plain, TAB-separated):
  <file>:<startLine> <TAB> <callerQname> <TAB> [<callLine1>,<callLine2>,...]

Stderr:
  # ambiguousIn: <files…>   Pass --file to pick the right target

Exit: 0=callers found, 1=no callers, 2=usage/qname missing, 3=server

Examples:
  cock codegraph callers getCodeIndex
  cock codegraph callers GET --file packages/feature/explorer/src/server/api/projectGraph/risk.ts
  cock codegraph callers handleSlackMention --json`,

  callees: `Usage: cock codegraph callees <qname> [--file PATH] [--json]

Purpose:  What <qname> calls directly (1-hop outgoing). Mirror of
          'callers'. Same shape, opposite direction.

Flags: same as 'callers'

Output (plain, TAB-separated):
  <file>:<startLine> <TAB> <calleeQname> <TAB> [<callLine1>,<callLine2>,...]

Exit: 0=callees found, 1=none, 2=usage, 3=server

Examples:
  cock codegraph callees runDialogue
  cock codegraph callees generateReply --file apps/api/.../event-handler.ts`,

  impact: `Usage: cock codegraph impact <qname> [--file PATH] [--depth N=2] [--json]

Purpose:  Transitive callers via BFS, up to <depth> hops. Returns a
          flat node list capped at 500 server-side. For ranked + bounded
          output prefer 'risk' (which wraps this and overlays scoring).

Flags:
  --file PATH      Disambiguate qname across files
  --depth N        BFS depth (1-5, default 2)
  --json           Raw JSON {qname, target, nodes: [...], truncated, ambiguousIn?}

Output (plain, TAB-separated):
  d=<depth> <TAB> <file>:<startLine> <TAB> <qname>

Stderr:
  # impact truncated at server cap (500). Use 'risk' for ranked + bounded output.

Exit: 0=impacted nodes, 1=target only / no impact, 2=usage, 3=server

Examples:
  cock codegraph impact getCodeIndex
  cock codegraph impact validateCwd --depth 3
  cock codegraph impact handleSlackMention --json | jq '.nodes | length'`,

  file: `Usage: cock codegraph file <path> [--json]

Purpose:  Symbol tree of one file. Useful for "what's in this file" or
          for picking a qname to feed to callers/related/risk.

Flags:
  --json           Raw JSON {filePath, language, symbols: [...]} (hierarchical)

Output (plain, TAB-separated):
  <kind> <TAB> <startLine>-<endLine> <TAB> <qname>

Exit: 0=symbols found, 1=empty file / not indexed, 2=usage, 3=server

Examples:
  cock codegraph file packages/feature/explorer/src/server/codeMap/types.ts
  cock codegraph file apps/api/src/features/agent-integrations/event-handler.ts --json`,

  coedit: `Usage: cock codegraph coedit <path> [--commits N=100] [--json]

Purpose:  Files frequently edited together with <path> in git history.
          Captures "convention coupling" (parallel registries, double-
          writes, sibling docs) that the call graph can't see. Auto-falls
          back to merge-granularity for squash-style projects.

Flags:
  --commits N      Git log scan window (default 100, max 1000)
  --json           Raw JSON {target, totalCommits, history: [...], uncommitted: [...]}

Output (plain, TAB-separated):
  # history (cooccurrence/total)
  <cooccur>/<total> <TAB> <coeditFile>
  # uncommitted (working tree)
  - <TAB> <file>

Exit: 0=signal found, 1=no cooccurrence (totalCommits may be 0), 2=usage, 3=server

Examples:
  cock codegraph coedit apps/api/.../event-handler.ts
  cock codegraph coedit packages/feature/agent/src/server/lib/cgPrompt.ts --commits 500`,

  context: `Usage: cock codegraph context [--query Q] [--cursor C] [--open F1,F2,...]
                              [--top N=15] [--json]

Purpose:  Semantic retrieval. Combine free-text query, a cursor anchor,
          and currently-open files; returns Top-K relevant coordinates
          ranked by PPR + TF-IDF + PageRank. Use when you DON'T know
          the symbol's name, only intent.

At least one of --query / --cursor / --open is required.

Flags:
  --query Q        Free-text seed (TF-IDF tokenised)
  --cursor C       Anchor at "<file>::<qname>" OR "<file>:<line>" — accepts
                   '.' as separator, bare qname, case-insensitive, ±5 line fuzzy
  --open F1,F2,... Comma-separated paths of currently-open files (weak seeds)
  --top N          Result cap (1-50, default 15)
  --json           Raw JSON {results, seeds, cursorResolution, degraded, degradedReason?}

Output (plain, TAB-separated, score descending):
  <score> <TAB> <file>:<startLine> <TAB> <qname> <TAB> [<sig1>,<sig2>,...]
  signals: query-match | ppr | pagerank | open

Stderr:
  # cursor: <note>           Cursor format auto-corrected
  # cursor not matched: ...  Cursor failed; results may still come from query/open
  # degraded: <reason>       analytics-warming = index not ready yet

Exit: 0=results, 1=no results, 2=usage/no seeds, 3=server

Examples:
  cock codegraph context --query "spawn language server shutdown"
  cock codegraph context --query "auth flow" --cursor src/auth.ts::login
  cock codegraph context --cursor src/api.ts:42 --top 5`,

  related: `Usage: cock codegraph related <qname> [--file PATH] [--top N=10]
                              [--include all|structural|coedit] [--json]

Purpose:  Broader 1-hop relatedness than callers/callees alone. Combines
          direct callers + callees + PPR neighbours + Louvain community
          siblings + frequent coedit partners into one ranked list.

Flags:
  --file PATH      Disambiguate qname across files
  --top N          Result cap (1-30, default 10)
  --include K      Limit relation kinds (default: all)
                     structural = callers/callees + PPR + community
                     coedit     = coedit only
  --json           Raw JSON {target, results, ambiguousIn?, coedit, degraded}

Output (plain, TAB-separated, score descending):
  <score> <TAB> <file>:<startLine> <TAB> <qname> <TAB> <<rel1>,<rel2>,...>
  relations: caller | callee | ppr-neighbor | frequent-coedit | sibling-in-community

Stderr:
  # ambiguousIn: <files…>   Same qname in multiple files
  # degraded: <reason>      coedit-unavailable / analytics-warming

Exit: 0=results, 1=no relatives, 2=usage, 3=server

Examples:
  cock codegraph related getCodeIndex --top 5
  cock codegraph related NewRoutineModal --include structural
  cock codegraph related GET --file packages/feature/explorer/src/server/api/projectGraph/risk.ts`,

  risk: `Usage: cock codegraph risk <qname> [--file PATH] [--depth N=2]
                           [--top N=20] [--json]

Purpose:  Risk-scored impact. Wraps 'impact' BFS and overlays
          callFreq + coeditProb + hasTest + pagerank per node. Returns
          the top-K highest-risk nodes + suggestedTests + the target
          file's coedit history (don't re-call /coedit on the same file).
          Use for "I'm about to change X — what should I worry about?"

Flags:
  --file PATH      Disambiguate qname
  --depth N        BFS depth (1-5, default 2)
  --top N          High-risk cap (1-50, default 20)
  --json           Raw JSON {target, totalImpactedNodes, highRisk, suggestedTests, coedit, degraded}

Output (plain, TAB-separated, risk.score descending):
  # total impacted: <N>
  <score> <TAB> d=<depth> <TAB> <file>:<startLine> <TAB> <qname> <TAB> [<tag1>,<tag2>,...]
  tags: high-risk | untested | frequent-coedit | core | leaf

  Followed by (if non-empty):
  # suggestedTests
  <reason> <TAB> <testFile> <TAB> (<covered qname1>, <qname2>, ...)
  reason: direct-test | coedit-history

Stderr:
  # degraded: <reason>      coedit-unavailable / analytics-warming

Exit: 0=high-risk nodes returned, 1=qname not found, 2=usage, 3=server

Examples:
  cock codegraph risk handleSlackMention
  cock codegraph risk getCodeIndex --depth 3 --top 10
  cock codegraph risk validateCwd --json | jq '.suggestedTests[].filePath'`,

  affected: `Usage: cock codegraph affected <files…|--stdin>
                              [--depth N=10] [--filter GLOB]
                              [--as-cmd RUNNER] [--include-all] [--json]

Purpose:  Test files transitively affected by changing the input files.
          File-level reverse-import closure. Recall-oriented (catch every
          relevant test, may over-include) where 'risk' is precision-
          oriented (highlight a few high-impact symbols). Use this for
          CI selective-test pipelines.

Detects test files by convention: *.test.* / *.spec.* / test_*.py /
*_test.go / tests/*.rs / __tests__/* / *.e2e.*

Flags:
  --stdin          Read file list from stdin (one path per line; pairs
                   with 'git diff --name-only')
  --depth N        BFS depth (1-20, default 10)
  --filter GLOB    Restrict tests matching this glob (e.g. "**/*.e2e.ts")
  --as-cmd RUNNER  Emit a single shell command with all paths quoted, e.g.
                     --as-cmd jest          → jest "a" "b" …
                     --as-cmd "vitest run"  → vitest run "a" "b" …
                     --as-cmd "pytest -v"   → pytest -v "a" "b" …
                   Pick whatever your project's runner is — codegraph
                   doesn't assume jest. NOTE: filter your input set to
                   the matching language (e.g. --filter "**/*.test.ts")
                   if you mix JS+Python+Go test files in one repo.
  --include-all    Also report non-test affected files (JSON only)
  --json           Raw JSON {testFiles, byInput, unresolved, stats, degraded}

Output (default plain):
  <test/file/path>
  <test/file/path>
  ...                       (one path per line, alphabetically sorted)

With --as-cmd:
  <RUNNER> "path1" "path2" "..."
                            (single quoted shell command)

Stderr:
  codegraph affected: N input file(s) not found in CodeIndex
  codegraph affected: BFS hit node cap — results may miss deeper tests

Exit: 0=tests printed, 1=no tests affected (short-circuit in Makefile),
      2=usage, 3=server

Examples:
  git diff --name-only main | cock codegraph affected --stdin
  git diff --name-only | cock codegraph affected --stdin --as-cmd jest
  git diff --name-only | cock codegraph affected --stdin --as-cmd "vitest run"
  cock codegraph affected src/auth.ts --filter "**/*.e2e.ts"
  cock codegraph affected --stdin --json | jq '.byInput[] | {file, tests: .reachableTests | length}'`,
}; }

function printSubHelp(name) {
  const h = getSubHelp()[name];
  if (!h) {
    printTopHelp();
    return;
  }
  stdout.write(h + '\n');
}

// Exported for cock.mjs `await mod.done` pattern.
export const done = Promise.resolve();
