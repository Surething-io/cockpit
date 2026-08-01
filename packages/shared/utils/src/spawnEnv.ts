/**
 * Environment sanitizer for every child process cockpit spawns.
 *
 * WHY THIS EXISTS
 * ---------------
 * The production server calls `next({ dev: false })` and then `app.prepare()`.
 * The constructor is innocent, but `prepare()` writes into `process.env` of the
 * cockpit server process:
 *
 *     NODE_ENV="production"     NEXT_DEPLOYMENT_ID=""     TURBOPACK="auto"
 *
 * Every child we spawn with `{ ...process.env }` (agent engines, PTY drivers,
 * bash bubbles, Jupyter kernels) inherits those. The agent then runs commands
 * in the *user's* project under production semantics — which is wrong and
 * fails in ways that point nowhere near cockpit. The canonical symptom:
 * `React.act` is a dev-only export, so a production `NODE_ENV` turns every
 * component test into `TypeError: React.act is not a function`, which reads
 * like a broken react-dom install.
 *
 * This only reproduces in prod mode (`cockpit` / `cock`); the dev server takes
 * the `dev: true` branch and never sets these — so you cannot see it while
 * developing cockpit itself.
 *
 * WHY WE STRIP AT THE SPAWN BOUNDARY
 * ----------------------------------
 * We cannot fix `process.env` in the server: the Next runtime keeps reading
 * `NODE_ENV` for the lifetime of the process. So the sanitizing happens at the
 * boundary, once, here.
 *
 * WHY A DENY-LIST AND NOT AN ALLOW-LIST
 * -------------------------------------
 * `terminalHandler.ts` rebuilds its env from scratch (allow-list) and that is
 * the stricter design, but a spawned agent legitimately needs a long tail of
 * inherited variables — ANTHROPIC_*, proxy settings, PATH, whatever the user's
 * shell exported. Enumerating them is a losing game. We remove exactly what
 * Next injected and pass the rest through.
 *
 * Note we do NOT try to preserve a NODE_ENV the user exported before launching
 * cockpit: by the time `prepare()` has run, the original value is unknowable.
 * Unset is the correct default for someone else's project.
 */

/**
 * Variables injected into the server process by Next's `app.prepare()`.
 * Adding to this list is cheap; missing one costs an afternoon of debugging.
 */
export const NEXT_INJECTED_ENV_KEYS = [
  'NODE_ENV',
  'NEXT_DEPLOYMENT_ID',
  'TURBOPACK',
] as const;

/**
 * Return type note: the two consumers disagree, so we satisfy both.
 * `child_process` options want `NodeJS.ProcessEnv`, which Next's global.d.ts
 * augments with a REQUIRED `NODE_ENV` — precisely the key we are removing. The
 * Claude Agent SDK wants `Record<string, string>`. Neither type can express
 * "a normal env that happens to have NODE_ENV unset", which is a perfectly
 * legal thing to hand to spawn(). The intersection satisfies both call sites
 * and the single cast that produces it is confined to this function.
 */
export type SpawnEnv = NodeJS.ProcessEnv & Record<string, string>;

/**
 * A copy of `process.env` with the host Next server's fingerprint removed,
 * safe to hand to a child process working inside a user project.
 *
 * @param overrides applied AFTER stripping, so a caller can deliberately set
 *   one of the stripped keys back (nothing does today, but a test runner
 *   wrapper might want `NODE_ENV=test`). An `undefined` value deletes the key.
 * @param base defaults to `process.env`; injectable for tests.
 */
export function sanitizedSpawnEnv(
  overrides: Record<string, string | undefined> = {},
  base: NodeJS.ProcessEnv = process.env,
): SpawnEnv {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(base)) {
    if (value !== undefined) out[key] = value;
  }
  for (const key of NEXT_INJECTED_ENV_KEYS) delete out[key];
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete out[key];
    else out[key] = value;
  }
  return out as SpawnEnv;
}
