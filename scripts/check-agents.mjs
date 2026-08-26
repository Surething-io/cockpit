/**
 * Report how far the pinned agent SDKs are behind the registry.
 *
 * Both SDKs are pinned to an EXACT version on purpose (see package.json). A caret range would
 * let every user's install resolve to whatever shipped that day, so the version under test and
 * the version in the field silently diverge — and the SDK performs NO version negotiation with
 * the CLI it spawns, so that divergence is unguarded. The cost of pinning is that nothing
 * upgrades on its own; this script is the thing that tells you when to.
 *
 * The pairing that matters is not the SDK version but the CLI version behind it:
 *   @anthropic-ai/claude-agent-sdk  declares `claudeCodeVersion` (the bundled Claude Code build)
 *   @openai/codex-sdk               pins `@openai/codex` exactly (SDK and CLI move together)
 *
 * Run: npm run check-agents           human-readable table
 *      npm run check-agents -- --json  machine-readable, for CI
 *
 * Always exits 0. Being behind is information, not a build failure — a release must never be
 * blocked because Anthropic published while CI was running.
 */
import { readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const FETCH_TIMEOUT_MS = 5_000;

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'));

/** Installed package.json, or null when the dependency is absent.
 *  Read straight off disk: both SDKs declare an `exports` map that does not include
 *  `./package.json`, so `require.resolve` fails with ERR_PACKAGE_PATH_NOT_EXPORTED. */
function installed(name) {
  try {
    return readJson(join(root, 'node_modules', ...name.split('/'), 'package.json'));
  } catch {
    return null;
  }
}

/** `latest` dist-tag, or null on any failure (offline, blocked, 5xx). Never throws. */
async function latest(name) {
  try {
    const res = await fetch(`https://registry.npmjs.org/${encodeURIComponent(name)}/latest`, {
      headers: { accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return (await res.json()).version ?? null;
  } catch {
    return null;
  }
}

const pkg = readJson(join(root, 'package.json'));

const targets = [
  {
    name: '@anthropic-ai/claude-agent-sdk',
    // The CLI build this SDK ships and is version-locked to.
    cli: (meta) => (meta?.claudeCodeVersion ? `claude ${meta.claudeCodeVersion}` : null),
  },
  {
    name: '@openai/codex-sdk',
    cli: (meta) => {
      const v = meta?.dependencies?.['@openai/codex'];
      return v ? `codex ${v}` : null;
    },
  },
];

const rows = await Promise.all(
  targets.map(async (t) => {
    const meta = installed(t.name);
    const [declared, live] = [pkg.dependencies?.[t.name] ?? '—', await latest(t.name)];
    const local = meta?.version ?? '—';
    return {
      name: t.name,
      declared,
      local,
      latest: live ?? '(unreachable)',
      cli: t.cli(meta) ?? '—',
      behind: live != null && meta?.version != null && live !== meta.version,
    };
  }),
);

if (process.argv.includes('--json')) {
  console.log(JSON.stringify({ behind: rows.some((r) => r.behind), packages: rows }, null, 2));
  process.exit(0);
}

console.table(
  rows.map((r) => ({
    PACKAGE: r.name,
    DECLARED: r.declared,
    INSTALLED: r.local,
    LATEST: r.latest,
    'BUNDLED CLI': r.cli,
  })),
);

const behind = rows.filter((r) => r.behind);
if (behind.length) {
  console.log('To upgrade, set the exact version in package.json and run `npm install`:');
  for (const r of behind) console.log(`  ${r.name}: ${r.local} -> ${r.latest}`);
  console.log();
  console.log('Upgrading Claude also replaces the bundled CLI, so re-run the test suite after.');
  console.log();
}
