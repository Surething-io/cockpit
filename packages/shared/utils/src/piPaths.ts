// Pi's native session layout, rooted in the Cockpit data directory.
import { join, resolve, sep } from 'path';
import { COCKPIT_DIR } from './paths';

export const PI_AGENT_DIR = join(COCKPIT_DIR, 'pi');
export const PI_SESSIONS_DIR = join(PI_AGENT_DIR, 'sessions');
export { PI_ENGINES, isPiEngine, type PiEngine } from './piEngines';

/** Match Pi's project-directory encoding without creating directories. */
export function getPiSessionsDir(cwd: string): string {
  return join(PI_SESSIONS_DIR, `--${resolve(cwd).replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`);
}

/** Recognize only sessions in Cockpit's Pi store. */
export function isPiSessionPath(file: string): boolean {
  return resolve(file).startsWith(`${resolve(PI_SESSIONS_DIR)}${sep}`);
}
