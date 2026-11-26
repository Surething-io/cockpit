// Demo data for the homepage tour: two small Git projects and hand-written
// Claude sessions, all fictional. The tour is published on the website, so
// nothing here may come from a real machine — no real sessions, no real paths.
//
// Everything lives under one root (default /Users/Shared/demo): the projects,
// and a private HOME for the Cockpit instance being captured, so it reads only
// these sessions and never touches the user's ~/.cockpit or ~/.claude.
import { execFileSync } from 'child_process';
import { mkdirSync, rmSync, writeFileSync } from 'fs';
import { dirname, join } from 'path';

/** Same rule as packages/shared/utils/src/encodePath.ts: every non-alphanumeric char → '-'. */
function encodePath(p) {
  return p.replace(/[^a-zA-Z0-9]/g, '-');
}

function write(file, content) {
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, content);
}

function git(cwd, ...args) {
  execFileSync('git', args, {
    cwd,
    stdio: 'ignore',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Demo',
      GIT_AUTHOR_EMAIL: 'demo@example.com',
      GIT_COMMITTER_NAME: 'Demo',
      GIT_COMMITTER_EMAIL: 'demo@example.com',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_CONFIG_NOSYSTEM: '1',
    },
  });
}

// ─────────────────────────────────────────────────────────
// Projects
// ─────────────────────────────────────────────────────────

const ACME_README = `# acme-api

Payments and invoicing API for Acme.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| POST | \`/payments\` | Charges a customer. Send an \`Idempotency-Key\` header. |
| GET | \`/invoices/:id\` | Returns an invoice with its currency. |

## Retrying safely

Clients retry on timeouts. Reuse the same \`Idempotency-Key\` for every
retry of one payment: the first response is stored for 24 hours and
replayed, so a customer is never charged twice.

\`\`\`bash
curl -X POST localhost:3000/payments \\
  -H 'Idempotency-Key: 4f1c9a' \\
  -d '{"customerId":"cus_42","amount":19.99,"currency":"usd"}'
\`\`\`

## Development

\`\`\`bash
npm install
npm test
\`\`\`
`;

const PAYMENTS_BEFORE = `import { Router } from 'express';
import { charge } from '../lib/stripe';
import { toCents } from '../lib/money';

export const payments = Router();

payments.post('/payments', async (req, res) => {
  const { customerId, amount, currency } = req.body;
  const result = await charge({ customerId, amount: toCents(amount), currency });
  res.status(201).json(result);
});
`;

const PAYMENTS_AFTER = `import { Router } from 'express';
import { charge } from '../lib/stripe';
import { toCents } from '../lib/money';
import { idempotency } from '../lib/idempotency';

export const payments = Router();

payments.post('/payments', async (req, res) => {
  const key = req.header('Idempotency-Key');
  if (!key) return res.status(400).json({ error: 'Idempotency-Key header is required' });

  const cached = await idempotency.get(key);
  if (cached) return res.status(cached.status).json(cached.body);

  const { customerId, amount, currency } = req.body;
  const result = await charge({ customerId, amount: toCents(amount), currency });
  await idempotency.set(key, { status: 201, body: result });
  res.status(201).json(result);
});
`;

const IDEMPOTENCY = `// Responses keyed by the client's Idempotency-Key, kept for 24 hours.
const TTL_MS = 24 * 60 * 60 * 1000;
const store = new Map<string, { status: number; body: unknown; at: number }>();

export const idempotency = {
  async get(key: string) {
    const hit = store.get(key);
    if (!hit || Date.now() - hit.at > TTL_MS) return undefined;
    return hit;
  },
  async set(key: string, value: { status: number; body: unknown }) {
    store.set(key, { ...value, at: Date.now() });
  },
};
`;

function seedApi(dir) {
  write(join(dir, 'package.json'), JSON.stringify({ name: 'acme-api', private: true, type: 'module', scripts: { test: 'node --test' } }, null, 2) + '\n');
  write(join(dir, 'README.md'), ACME_README);
  write(join(dir, 'src/lib/money.ts'), `/** Major units (12.34) → integer cents (1234), rounding half up. */\nexport function toCents(amount: number): number {\n  return Math.round(amount * 100);\n}\n`);
  write(join(dir, 'src/lib/stripe.ts'), `export async function charge(input: { customerId: string; amount: number; currency: string }) {\n  return { id: 'ch_' + Math.random().toString(36).slice(2), ...input, status: 'succeeded' };\n}\n`);
  write(join(dir, 'src/routes/invoices.ts'), `import { Router } from 'express';\n\nexport const invoices = Router();\n\ninvoices.get('/invoices/:id', (req, res) => {\n  res.json({ id: req.params.id, status: 'open' });\n});\n`);
  write(join(dir, 'src/routes/payments.ts'), PAYMENTS_BEFORE);
  write(join(dir, 'test/money.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\nconst toCents = (n) => Math.round(n * 100);\n\ntest('converts major units to cents', () => assert.equal(toCents(12.34), 1234));\ntest('rounds half a cent up', () => assert.equal(toCents(0.125), 13));\n`);
  write(join(dir, 'test/idempotency.test.js'), `import { test } from 'node:test';\nimport assert from 'node:assert/strict';\n\nconst store = new Map();\nconst once = async (key, fn) => store.get(key) ?? store.set(key, await fn()).get(key);\n\ntest('replays the first response for a repeated key', async () => {\n  let charges = 0;\n  const pay = () => once('key-1', async () => ({ id: ++charges }));\n  assert.deepEqual(await pay(), await pay());\n  assert.equal(charges, 1);\n});\ntest('different keys charge separately', async () => {\n  assert.notDeepEqual(await once('a', async () => ({ id: 'a' })), await once('b', async () => ({ id: 'b' })));\n});\n`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Initial payments API');
  write(join(dir, 'src/routes/invoices.ts'), `import { Router } from 'express';\n\nexport const invoices = Router();\n\ninvoices.get('/invoices/:id', (req, res) => {\n  res.json({ id: req.params.id, status: 'open', currency: 'usd' });\n});\n`);
  git(dir, 'commit', '-qam', 'Return the invoice currency');
  // The change the tour's session made, left uncommitted so Explorer shows it.
  write(join(dir, 'src/routes/payments.ts'), PAYMENTS_AFTER);
  write(join(dir, 'src/lib/idempotency.ts'), IDEMPOTENCY);
}

function seedWeb(dir) {
  write(join(dir, 'package.json'), JSON.stringify({ name: 'web-dashboard', private: true }, null, 2) + '\n');
  write(join(dir, 'README.md'), '# web-dashboard\n\nInternal dashboard for payments and invoices.\n');
  write(join(dir, 'src/pages/Invoices.tsx'), `export function Invoices() {\n  return <h1>Invoices</h1>;\n}\n`);
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'Dashboard skeleton');
}

// ─────────────────────────────────────────────────────────
// Sessions (Claude transcript format: one JSON object per line)
// ─────────────────────────────────────────────────────────

function transcript({ cwd, sessionId, start, turns }) {
  let parent = null;
  let n = 0;
  let t = Date.parse(start);
  const lines = [];
  const push = (entry) => {
    const uuid = `${sessionId.slice(0, 8)}-0000-4000-8000-${String(++n).padStart(12, '0')}`;
    t += 4000;
    lines.push({ ...entry, uuid, parentUuid: parent, sessionId, cwd, timestamp: new Date(t).toISOString(), version: '2.1.0', gitBranch: 'main', isSidechain: false, userType: 'external' });
    parent = uuid;
  };
  for (const turn of turns) {
    if (turn.user) push({ type: 'user', message: { role: 'user', content: turn.user } });
    if (turn.assistant) {
      push({
        type: 'assistant',
        message: { id: `msg_${n}`, type: 'message', role: 'assistant', model: 'claude-opus-4-5', content: turn.assistant, stop_reason: turn.tool ? 'tool_use' : 'end_turn', usage: { input_tokens: 1200, output_tokens: 320 } },
      });
    }
    if (turn.toolResult) {
      push({ type: 'user', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: turn.toolResult.id, content: turn.toolResult.content }] } });
    }
  }
  return lines.map((l) => JSON.stringify(l)).join('\n') + '\n';
}

function idempotencySession(cwd) {
  const tool = (id, name, input) => ({ type: 'tool_use', id, name, input });
  return transcript({
    cwd,
    sessionId: '7f3c2a10-5b6d-4e8f-9a1b-2c3d4e5f6a7b',
    start: '2026-11-26T09:12:00Z',
    turns: [
      { user: "Retries are double-charging customers. Make POST /payments idempotent with an Idempotency-Key header." },
      { assistant: [{ type: 'text', text: "I'll look at the payments route first." }, tool('toolu_01', 'Read', { file_path: `${cwd}/src/routes/payments.ts` })], tool: true },
      { toolResult: { id: 'toolu_01', content: PAYMENTS_BEFORE } },
      { assistant: [{ type: 'text', text: 'Each retry calls `charge()` again. I\'ll cache the first response per key for 24 hours and replay it.' }, tool('toolu_02', 'Write', { file_path: `${cwd}/src/lib/idempotency.ts`, content: IDEMPOTENCY })], tool: true },
      { toolResult: { id: 'toolu_02', content: `File created successfully at: ${cwd}/src/lib/idempotency.ts` } },
      { assistant: [tool('toolu_03', 'Edit', { file_path: `${cwd}/src/routes/payments.ts`, old_string: PAYMENTS_BEFORE, new_string: PAYMENTS_AFTER })], tool: true },
      { toolResult: { id: 'toolu_03', content: `The file ${cwd}/src/routes/payments.ts has been updated successfully.` } },
      { assistant: [tool('toolu_04', 'Bash', { command: 'npm test', description: 'Run the test suite' })], tool: true },
      { toolResult: { id: 'toolu_04', content: '✔ converts major units to cents\n✔ rounds half a cent up\n✔ replays the first response for a repeated key\n✔ different keys charge separately\nℹ tests 4\nℹ pass 4\nℹ fail 0' } },
      {
        assistant: [
          {
            type: 'text',
            text: "Done. `POST /payments` now requires an `Idempotency-Key` header:\n\n- **First request** charges the card and stores the response for 24 hours.\n- **Retries with the same key** get the stored response back — no second charge.\n- **Missing key** returns `400`.\n\nAll 4 tests pass. The store is in-memory; for more than one instance, back it with Redis.",
          },
        ],
      },
    ],
  });
}

function simpleSession(cwd, sessionId, start, question, answer) {
  return transcript({ cwd, sessionId, start, turns: [{ user: question }, { assistant: [{ type: 'text', text: answer }] }] });
}

// ─────────────────────────────────────────────────────────

export const DEFAULT_ROOT = '/Users/Shared/demo';

/**
 * Create (or recreate) the demo world under `root`. Returns the paths the
 * capture needs. Refuses any root that isn't clearly a throwaway demo dir.
 */
export function seed(root = DEFAULT_ROOT) {
  if (!/\/demo\/?$/.test(root)) throw new Error(`refusing to seed outside a */demo directory: ${root}`);
  rmSync(root, { recursive: true, force: true });
  const home = join(root, '.home');
  const api = join(root, 'acme-api');
  const web = join(root, 'web-dashboard');
  seedApi(api);
  seedWeb(web);

  const claudeProjects = join(home, '.claude', 'projects');
  write(join(claudeProjects, encodePath(api), '7f3c2a10-5b6d-4e8f-9a1b-2c3d4e5f6a7b.jsonl'), idempotencySession(api));
  write(
    join(claudeProjects, encodePath(api), '2b8e4d61-0c7a-4f3e-8d5b-9a6c1e2f3d4b.jsonl'),
    simpleSession(api, '2b8e4d61-0c7a-4f3e-8d5b-9a6c1e2f3d4b', '2026-11-26T08:40:00Z', 'Why do invoice totals sometimes come out one cent off?', '`toCents` multiplies before rounding, so `0.125` becomes `12.5` and rounds to `13` — that part is right. The drift comes from summing floats first: add the line items in cents, then convert once.'),
  );
  write(
    join(claudeProjects, encodePath(web), '5d1f7b92-3e4a-4c6b-8f0d-1a2b3c4d5e6f.jsonl'),
    simpleSession(web, '5d1f7b92-3e4a-4c6b-8f0d-1a2b3c4d5e6f', '2026-11-26T08:55:00Z', 'Add a status filter to the invoices page.', 'Added a status filter (open / paid / void) above the table. It keeps the selection in the URL, so a filtered view can be shared.'),
  );

  write(join(home, '.cockpit', 'projects.json'), JSON.stringify({ projects: [{ cwd: api }, { cwd: web }], activeIndex: 0, collapsed: false }, null, 2));
  // Which sessions each project has open. Without this the first visit opens an
  // empty "New Chat" tab beside them.
  const openSessions = (cwd, id) =>
    write(join(home, '.cockpit', 'projects', encodePath(cwd), 'session.json'), JSON.stringify({ sessions: [id], activeSessionId: id }, null, 2));
  openSessions(api, '7f3c2a10-5b6d-4e8f-9a1b-2c3d4e5f6a7b');
  openSessions(web, '5d1f7b92-3e4a-4c6b-8f0d-1a2b3c4d5e6f');
  return { root, home, api, web };
}
