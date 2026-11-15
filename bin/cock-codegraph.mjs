#!/usr/bin/env node
/**
 * cockpit codegraph — unified CLI for /api/projectGraph/* endpoints.
 *
 * Usage:
 *   cockpit codegraph                         List subcommands
 *   cockpit codegraph <sub> --help            Per-subcommand help
 *   cockpit codegraph <sub> ... [--json]      All subcommands accept --json
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

// The CLI always talks to the co-located server over loopback — same contract
// as /cg's agent curls. We deliberately do NOT honor COCKPIT_HOST here: pointing
// the CLI at a remote/public host would go through the auth gate, and the only
// real consumer is the server running on this machine.
const PORT = env.COCKPIT_PORT || env.PORT || '3457';
const BASE = `http://localhost:${PORT}`;

const SUBCMDS = [
  'search', 'symbols', 'callers', 'callees', 'impact', 'file', 'coedit',
  'related', 'affected',
];

const sub = argv[2];

if (!sub || sub === '-h' || sub === '--help') {
  printTopHelp();
  await writeOutput();
  exit(0);
}

if (!SUBCMDS.includes(sub)) {
  stderr.write(`cockpit codegraph: unknown subcommand "${sub}"\n`);
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
  await writeOutput();
  exit(0);
}

// Dispatch.
try {
  switch (sub) {
    case 'search':   await cmdSearch(); break;
    case 'symbols':  await cmdSymbols(); break;
    case 'callers':  await cmdCallers(); break;
    case 'callees':  await cmdCallees(); break;
    case 'impact':   await cmdImpact(); break;
    case 'file':     await cmdFile(); break;
    case 'coedit':   await cmdCoedit(); break;
    case 'related':  await cmdRelated(); break;
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
    if (Array.isArray(v)) {
      for (const item of v) url.searchParams.append(k, String(item));
    } else {
      url.searchParams.set(k, String(v));
    }
  }
  let resp;
  try {
    resp = await fetch(url);
  } catch (err) {
    stderr.write(
      `codegraph: cannot reach Cockpit at ${BASE}\n` +
        `        (${err?.code ?? err?.name ?? 'fetch failed'})\n` +
        `        Start it with: cockpit\n`,
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
        `        Start it with: cockpit\n`,
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
      '--query', '--cursor', '--open', '--filter', '--include', '--path',
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

function writeOutput(text = '') {
  return new Promise((resolve, reject) => {
    stdout.write(text, error => error ? reject(error) : resolve());
  });
}

async function emitJson(obj) {
  await writeOutput(JSON.stringify(obj, null, 2) + '\n');
}

// ============================================================================
// search
// ============================================================================

async function cmdSearch() {
  const pos = positional(subArgs);
  const q = pos[0];
  const limit = getInt(subArgs, '--limit') ?? 50;
  // v1.0.216+: opt-in flag to also surface identifier-shaped string literals
  // (tool names / event names / config keys / route paths) that only exist
  // in source as strings, never as identifiers.
  const includeLiterals = subArgs.includes('--include-literals');
  if (!q) {
    stderr.write('codegraph search: missing <query>\n');
    exit(2);
  }
  const params = { q, limit };
  const path = getFlag(subArgs, '--path');
  if (subArgs.includes('--path') && !path) throw new Error('--path requires a value');
  if (path) params.path = path;
  if (subArgs.includes('--exclude-tests')) params.excludeTests = 'true';
  if (includeLiterals) params.includeLiterals = 'true';
  const resp = await get('/api/projectGraph/search', params);
  const data = await resp.json();
  if (wantJson) { await emitJson(data); exit(0); }

  const files = data.files || [];
  const syms = data.symbols || [];
  const literals = data.literals || [];
  if (files.length === 0 && syms.length === 0 && literals.length === 0) exit(1);

  for (const f of files) {
    stdout.write(`file\t${f.target?.filePath ?? f.label}\n`);
  }
  for (const s of syms) {
    const t = s.target;
    stdout.write(`sym \t${t.filePath}:${t.startLine}\t${t.kind}\t${t.qualifiedName}\n`);
  }
  for (const hit of literals) stdout.write(`literal\t${hit.filePath}:${hit.line}\t${hit.value}\n`);
  await writeOutput();
  exit(0);
}

// ============================================================================
// symbols — one request for all matching symbols in the current revision
// ============================================================================

async function cmdSymbols() {
  const params = { kind: [], exclude: [] };
  for (let i = 0; i < subArgs.length; i++) {
    const flag = subArgs[i];
    if (flag === '--json') continue;
    if (flag === '--exclude-tests') { params.excludeTests = 'true'; continue; }
    if (flag === '--include-synthetic') { params.includeSynthetic = 'true'; continue; }
    if (flag === '--summary') { params.format = 'summary'; continue; }
    if (!['--path', '--kind', '--exclude'].includes(flag)) {
      throw new Error(`unknown symbols option "${flag}"`);
    }
    const value = subArgs[++i];
    if (!value || value.startsWith('--')) throw new Error(`${flag} requires a value`);
    if (flag === '--path') params.path = value;
    else if (flag === '--kind') params.kind.push(value);
    else params.exclude.push(value);
  }
  const resp = await get('/api/projectGraph/symbols', params);
  const data = await resp.json();
  if (data.incomplete) stderr.write('# incomplete: source index coverage is incomplete\n');
  if (wantJson) { await emitJson(data); exit(0); }
  if (params.format === 'summary') {
    stdout.write(`total\t${data.total}\tfiles\t${data.files}\n`);
    for (const row of data.byDirectory) {
      const kinds = Object.entries(row.byKind).map(([kind, count]) => `${kind}=${count}`).join(',');
      stdout.write(`${row.path}\t${row.total}\t${row.files}\t${kinds}\n`);
    }
    await writeOutput();
    exit(0);
  }
  if (!data.symbols.length) exit(1);
  for (const s of data.symbols) {
    stdout.write(`${s.filePath}:${s.startLine}-${s.endLine}\t${s.kind}\t${s.qualifiedName}\n`);
  }
  await writeOutput();
  exit(0);
}

// ============================================================================
// callers / callees (shared shape)
// ============================================================================

async function cmdCallers() { await runCallSide('callers'); }
async function cmdCallees() { await runCallSide('callees'); }

async function requireUnambiguous(data) {
  if (!data.ambiguousIn?.length) return;
  stderr.write(`# ambiguousIn: ${data.ambiguousIn.join(', ')} — pass --file to disambiguate; no relations computed\n`);
  if (wantJson) await emitJson(data);
  exit(2);
}

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
  await requireUnambiguous(data);
  if (wantJson) { await emitJson(data); exit(0); }

  const list = data[kind] || [];
  if (list.length === 0) exit(1);
  for (const item of list) {
    const node = item.caller || item.callee;
    const lines = (item.callLines || []).join(',');
    stdout.write(`${node.filePath}:${node.startLine}\t${node.qualifiedName}\t[${lines}]\n`);
  }
  await writeOutput();
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
  await requireUnambiguous(data);
  if (wantJson) { await emitJson(data); exit(0); }

  const nodes = data.nodes || [];
  if (data.truncated) {
    stderr.write(`# impact truncated at server cap (500). Narrow the query or lower --depth.\n`);
  }
  if (nodes.length === 0) exit(1);
  for (const n of nodes) {
    const s = n.symbol;
    stdout.write(`d=${n.depth}\t${s.filePath}:${s.startLine}\t${s.qualifiedName}\n`);
  }
  await writeOutput();
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
  if (wantJson) { await emitJson(data); exit(0); }

  const syms = data.symbols || [];
  if (syms.length === 0) exit(1);
  for (const s of syms) {
    stdout.write(`${s.kind}\t${s.startLine}-${s.endLine}\t${s.qualifiedName}\n`);
  }
  await writeOutput();
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
  if (wantJson) { await emitJson(data); exit(0); }

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
  await writeOutput();
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
  await requireUnambiguous(data);
  if (wantJson) { await emitJson(data); exit(0); }

  if (data.degraded) stderr.write(`# degraded: ${data.degradedReason}\n`);
  const results = data.results || [];
  if (results.length === 0) exit(1);
  for (const r of results) {
    const rels = (r.relations || []).map((x) => x.type).join(',');
    stdout.write(`${r.score.toFixed(2)}\t${r.filePath}:${r.startLine}\t${r.qualifiedName}\t<${rels}>\n`);
  }
  await writeOutput();
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
    await emitJson(data);
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
    await writeOutput(`${asCmd} ${paths.map((p) => JSON.stringify(p)).join(' ')}\n`);
    exit(0);
  }
  if (paths.length === 0) exit(1);
  stdout.write(paths.join('\n') + '\n');
  await writeOutput();
  exit(0);
}

// ============================================================================
// Help text
// ============================================================================

function printTopHelp() {
  stdout.write(`Usage: cockpit codegraph <subcommand> [options]

Lookups (mirror existing /api/projectGraph/* endpoints — coordinates only):
  search   <query>                       Find symbols by name (file + qname hits)
  symbols  [--path DIR] [--kind KINDS]   Export all matching function/method symbols
           [--exclude-tests] [--exclude GLOB] (repeatable)
  callers  <qname> [--file PATH]         Direct callers of a symbol
  callees  <qname> [--file PATH]         What a symbol calls
  impact   <qname> [--depth N=2]         Transitive callers BFS (bounded traversal)
  file     <path>                        Symbol tree of a file
  coedit   <path> [--commits N=100]      Files co-edited in git history

Derived queries (base index + on-demand git):
  related  <qname> [--file PATH]
           [--top N=10]                  Broader neighbours: caller/callee + coedit
  affected <files…|--stdin>
           [--depth N=10] [--filter G]
           [--as-cmd RUNNER]              Test files transitively affected (CI / xargs)
           [--include-all]

Common flags (all subcommands):
  --json             Emit raw JSON response (full schema; see per-cmd --help)
  --help, -h         Subcommand-specific help (output format + exit codes + examples)

Plain output format (TAB-separated, one row per result):
  search    sym\\t<file>:<line>\\t<kind>\\t<qname>            or  file\\t<file>
  symbols   <file>:<startLine>-<endLine>\\t<kind>\\t<qname>
  callers   <file>:<line>\\t<qname>\\t[<callLines>]
  callees   <file>:<line>\\t<qname>\\t[<callLines>]
  impact    d=<depth>\\t<file>:<line>\\t<qname>
  file      <kind>\\t<startLine>-<endLine>\\t<qname>
  coedit    <cooccur>/<total>\\t<file>               (after '# history' comment)
  related   <score>\\t<file>:<line>\\t<qname>\\t<<relations>>
  affected  <file>                                  (one test path per line)

Diagnostics on stderr (don't break shell pipelines):
  # ambiguousIn: <files…>     No relations computed; pass --file (exit 2, also with --json)
  # degraded: <reason>        coedit-unavailable / truncated
  # incomplete: <reason>      Full export has incomplete source-index coverage

Exit codes:
  0  output produced
  1  empty result (no callers / no tests / no hits) — short-circuit shell pipelines
  2  argument or 4xx server error
  3  Cockpit server not reachable (start it: cockpit <project-path>)

Prerequisites:
  Cockpit server running at ${BASE}
  (override port: COCKPIT_PORT; host is always loopback)

Examples:
  cockpit codegraph search getCodeIndex
  cockpit codegraph symbols --path src --exclude-tests --json
  cockpit codegraph related getCodeIndex --top 5
  git diff --name-only | cockpit codegraph affected --stdin                       # → newline test paths
  git diff --name-only | cockpit codegraph affected --stdin --as-cmd jest         # → jest "a" "b" …
  git diff --name-only | cockpit codegraph affected --stdin --as-cmd "vitest run" # → vitest run "a" "b" …
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
 * Self-documenting like `cockpit terminal <id>` — agents are stateless between
 * tool calls, so the help has to carry everything they need.
 */
// Lazy — exposed via getSubHelp() so the top-level `printSubHelp(sub)`
// call (which runs before this declaration is reached in module order)
// doesn't hit a const TDZ.
function getSubHelp() { return {
  search: `Usage: cockpit codegraph search <query> [--limit N=50] [--path DIR]
                              [--exclude-tests] [--include-literals] [--json]

Purpose:  Find symbols by name and files by path, with case +
          word-separator folding (so 'build_code_index' ↔ 'buildCodeIndex'
          ↔ 'BUILD-CODE-INDEX' all collide). Use this when you know the
          symbol's name but not its location.

Flags:
  --limit N            Per-category result cap (default 50, maximum 500)
  --include-literals   Also search identifier-shaped string literals
                       in source (tool names / event names / config
                       keys / route paths). Off by default to keep
                       results lean. Surfaces names that never appear
                       as identifiers, only as strings.
  --path DIR           Project-relative directory, including descendants
  --exclude-tests      Exclude test files from files, symbols, and literals
  --json               Emit raw JSON {files: [...], symbols: [...]}

Ranking: raw exact name, normalized exact, normalized prefix, then substring.
All eligible candidates are scanned; only the best limit per category is retained.
Ties are stable by file path, qualified name, then line. Tests are included by default.

Output (plain, TAB-separated):
  sym <TAB> <file>:<line> <TAB> <kind> <TAB> <qname>
  file <TAB> <file>
  literal <TAB> <file>:<line> <TAB> <value>

JSON keys: files[].target, symbols[].target.{filePath,startLine,endLine,kind,qualifiedName}

Exit: 0=hits, 1=no hits, 2=usage, 3=server unreachable

Examples:
  cockpit codegraph search getCodeIndex
  cockpit codegraph search build_code_index             # snake-case query, still finds buildCodeIndex
  cockpit codegraph search useChatStore --path packages/feature --exclude-tests --limit 5
  cockpit codegraph search 'agent.fork' --include-literals    # find a name hiding in a literal
  cockpit codegraph search authenticate --json | jq '.symbols[].target'`,

  symbols: `Usage: cockpit codegraph symbols [--path DIR] [--kind KINDS]
                               [--exclude-tests] [--exclude GLOB] [--summary] [--include-synthetic] [--json]

Purpose: Export every matching symbol from one verified project-index revision.
         Defaults to functions and methods, including indexed nested symbols.
         No result-count cap. Only indexed supported source files are included.

Flags:
  --path DIR       Project-relative directory, including descendants (default: project)
  --kind KINDS     Comma-separated function,method,class,interface,type,enum,const,unknown;
                   or all (real symbols). Default: function,method. Repeatable.
  --exclude-tests  Exclude test/spec/e2e filenames, test/tests/__tests__ directories,
                   Python test_*.py/pyi and Go *_test.go (heuristic)
  --exclude GLOB   Project-relative POSIX glob, e.g. '**/generated/**'; repeatable.
                   Quote patterns to prevent shell expansion. Dot paths need explicit dots.
  --summary        Counts by kind and immediate child directory; no symbol list
  --include-synthetic  Include unknown UI display blocks (__imports__, __code_*)
  --json           Raw JSON; full export carries symbols[], summary carries files/byKind/byDirectory

Output (plain, TAB-separated):
  <file>:<startLine>-<endLine> <TAB> <kind> <TAB> <qualifiedName>

Source limit: 2 MiB per file, measured in actual bytes. JSON excludedFiles[] lists
              {filePath, reason: "source-too-large", sizeBytes, limitBytes} for the revision.
Stderr: # incomplete when the source index is capped; JSON also carries incomplete.
Exit: 0=output (including empty JSON), 1=empty plain output, 2=usage/server error, 3=unreachable

Examples:
  cockpit codegraph symbols --path packages/feature --kind all --exclude-tests --summary
  cockpit codegraph symbols --json > symbols.json
  cockpit codegraph symbols --path src --exclude-tests --exclude '**/generated/**' --json
  cockpit codegraph symbols --kind all --exclude '**/*.test.{ts,tsx}'`,

  callers: `Usage: cockpit codegraph callers <qname> [--file PATH] [--json]

Purpose:  Direct callers of <qname> (1-hop). For transitive use 'impact'.
          Pass --file when the qname exists in multiple files
          (ambiguous queries return a null target and no relations; exit 2).

Flags:
  --file PATH      Disambiguate when qname appears in multiple files
  --json           Emit raw JSON {qname, target, callers: [...]}

Output (plain, TAB-separated):
  <file>:<startLine> <TAB> <callerQname> <TAB> [<callLine1>,<callLine2>,...]

Stderr:
  # ambiguousIn: <files…>   Pass --file to pick the right target

Exit: 0=callers found, 1=no callers, 2=usage/ambiguous target, 3=server

Examples:
  cockpit codegraph callers getCodeIndex
  cockpit codegraph callers GET --file packages/feature/explorer/src/server/api/projectGraph/related.ts
  cockpit codegraph callers searchIndex --json`,

  callees: `Usage: cockpit codegraph callees <qname> [--file PATH] [--json]

Purpose:  What <qname> calls directly (1-hop outgoing). Mirror of
          'callers'. Same shape, opposite direction.

Flags: same as 'callers'

Output (plain, TAB-separated):
  <file>:<startLine> <TAB> <calleeQname> <TAB> [<callLine1>,<callLine2>,...]

Exit: 0=callees found, 1=none, 2=usage/ambiguous target, 3=server

Examples:
  cockpit codegraph callees runDialogue
  cockpit codegraph callees buildCodeIndex --file packages/feature/explorer/src/server/codeMap/projectGraph/codeIndex.ts`,

  impact: `Usage: cockpit codegraph impact <qname> [--file PATH] [--depth N=2] [--json]

Purpose:  Transitive callers via BFS, up to <depth> hops. Returns a
          flat node list capped at 500 server-side. Narrow the query or
          lower --depth when the result is truncated.

Flags:
  --file PATH      Disambiguate qname across files
  --depth N        BFS depth (1-5, default 2)
  --json           Raw JSON {qname, target, nodes: [...], truncated, ambiguousIn?}

Output (plain, TAB-separated):
  d=<depth> <TAB> <file>:<startLine> <TAB> <qname>

Stderr:
  # impact truncated at server cap (500). Narrow the query or lower --depth.

Exit: 0=impacted nodes, 1=target only / no impact, 2=usage/ambiguous target, 3=server

Examples:
  cockpit codegraph impact getCodeIndex
  cockpit codegraph impact validateCwd --depth 3
  cockpit codegraph impact searchIndex --json | jq '.nodes | length'`,

  file: `Usage: cockpit codegraph file <path> [--json]

Purpose:  Symbol tree of one file. Useful for "what's in this file" or
          for picking a qname to feed to callers/related.

Flags:
  --json           Raw JSON {filePath, language, symbols: [...]} (hierarchical)

Output (plain, TAB-separated):
  <kind> <TAB> <startLine>-<endLine> <TAB> <qname>

Exit: 0=symbols found, 1=empty file / not indexed, 2=usage, 3=server

Examples:
  cockpit codegraph file packages/feature/explorer/src/server/codeMap/types.ts
  cockpit codegraph file packages/feature/explorer/src/server/codeMap/projectGraph/codeIndex.ts --json`,

  coedit: `Usage: cockpit codegraph coedit <path> [--commits N=100] [--json]

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
  cockpit codegraph coedit packages/feature/explorer/src/server/codeMap/projectGraph/codeIndex.ts
  cockpit codegraph coedit packages/feature/agent/src/server/lib/cgPrompt.ts --commits 500`,

  related: `Usage: cockpit codegraph related <qname> [--file PATH] [--top N=10]
                              [--include all|structural|coedit] [--json]

Purpose:  Broader 1-hop relatedness than callers/callees alone. Combines
          direct callers + callees + frequent coedit partners into one
          ranked list, using only the base index and on-demand git.

Flags:
  --file PATH      Disambiguate qname across files
  --top N          Result cap (1-30, default 10)
  --include K      Limit relation kinds (default: all)
                     structural = callers/callees
                     coedit     = coedit only
  --json           Raw JSON {target, results, ambiguousIn?, coedit, degraded}

Output (plain, TAB-separated, score descending):
  <score> <TAB> <file>:<startLine> <TAB> <qname> <TAB> <<rel1>,<rel2>,...>
  relations: caller | callee | frequent-coedit

Stderr:
  # ambiguousIn: <files…>   Same qname in multiple files
  # degraded: <reason>      coedit-unavailable / truncated

Exit: 0=results, 1=no relatives, 2=usage/ambiguous target, 3=server

Examples:
  cockpit codegraph related getCodeIndex --top 5
  cockpit codegraph related NewRoutineModal --include structural
  cockpit codegraph related GET --file packages/feature/explorer/src/server/api/projectGraph/related.ts`,

  affected: `Usage: cockpit codegraph affected <files…|--stdin>
                              [--depth N=10] [--filter GLOB]
                              [--as-cmd RUNNER] [--include-all] [--json]

Purpose:  Test files transitively affected by changing the input files.
          File-level reverse-import closure. Recall-oriented (catch every
          relevant test, may over-include). Use this for
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
  git diff --name-only main | cockpit codegraph affected --stdin
  git diff --name-only | cockpit codegraph affected --stdin --as-cmd jest
  git diff --name-only | cockpit codegraph affected --stdin --as-cmd "vitest run"
  cockpit codegraph affected src/auth.ts --filter "**/*.e2e.ts"
  cockpit codegraph affected --stdin --json | jq '.byInput[] | {file, tests: .reachableTests | length}'`,
}; }

function printSubHelp(name) {
  const h = getSubHelp()[name];
  if (!h) {
    printTopHelp();
    return;
  }
  stdout.write(h + '\n');
}

// Exported for cockpit.mjs `await mod.done` pattern.
export const done = Promise.resolve();
