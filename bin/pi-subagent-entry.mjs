// Bootstrap the dependency's CLI without depending on PATH or exposing a key in argv at spawn.
import { fileURLToPath } from 'node:url';
const key = process.env.COCKPIT_PI_SUBAGENT_API_KEY;
if (!key) throw new Error('Missing Pi subagent credential');
delete process.env.COCKPIT_PI_SUBAGENT_API_KEY;
const cli = new URL('./cli.js', import.meta.resolve('@earendil-works/pi-coding-agent/rpc-entry'));
process.argv[1] = fileURLToPath(cli);
// Pi's native runtime override takes precedence over saved credentials. This
// mutation is in-process only; the key never appears in the OS command line.
process.argv.push('--api-key', key);
await import(cli.href);
