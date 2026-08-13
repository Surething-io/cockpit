// Single definition of the data dir for the plain-JS side (server.mjs + the
// bin/ CLI). packages/shared/utils/src/paths.ts carries the TypeScript twin for
// app code; that one cannot be shared here without pulling TS into the CLI, but
// there is no reason for the .mjs side to hold two copies of it.
//
// Keep the two in sync: COCKPIT_HOME wins, `~` expands, and the path is
// resolved so a relative value behaves.
import { homedir } from 'os';
import { join, resolve } from 'path';

export const COCKPIT_HOME_DIR = process.env.COCKPIT_HOME
  ? resolve(process.env.COCKPIT_HOME.replace(/^~(?=$|\/)/, homedir()))
  : join(homedir(), '.cockpit');

export const SERVER_JSON_PATH = join(COCKPIT_HOME_DIR, 'server.json');
export const LOG_DIR = join(COCKPIT_HOME_DIR, 'logs');

/**
 * Structured JSON lines from the app's Effect logger
 * (packages/shared/effect-core/src/logger.ts).
 */
export const APP_LOG_PATH = join(LOG_DIR, 'cockpit.log');

/**
 * Raw stdout/stderr of a backgrounded server (`cockpit start`).
 *
 * Deliberately NOT cockpit.log: that file is one JSON object per line and is
 * parsed as such, while this captures plain text (console output, Next's
 * startup banner, a stack trace from a crash). Mixing the two would break any
 * reader of either, and they want different rotation policies — this one is
 * held open as an fd for the life of the process.
 */
export const SERVER_LOG_PATH = join(LOG_DIR, 'server.log');
