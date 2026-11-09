import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Real compositor frames are required to test viewport acknowledgements. */
export async function captureBrowserDom(browser: string, directory: string): Promise<string> {
  const profile = join(directory, 'profile');
  const child = spawn(browser, ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--password-store=basic', '--use-mock-keychain',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let socket: WebSocket | undefined;
  const deadline = Date.now() + 45_000;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
  try {
    let port = '';
    while (!port) {
      if (child.exitCode !== null || Date.now() > deadline) throw new Error('Isolated browser did not start');
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then((text) => text.split('\n')[0], () => '');
      if (!port) await tick();
    }
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl: string; type: string }[];
    socket = new WebSocket(pages.find((page) => page.type === 'page')!.webSocketDebuggerUrl);
    await new Promise<void>((resolve, reject) => { socket!.addEventListener('open', () => resolve()); socket!.addEventListener('error', () => reject(new Error('Browser debugger connection failed'))); });
    let sequence = 0;
    const pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();
    socket.addEventListener('message', (event) => {
      const reply = JSON.parse(String(event.data));
      const request = pending.get(reply.id);
      if (!request) return;
      pending.delete(reply.id);
      if (reply.error) request.reject(new Error(JSON.stringify(reply.error))); else request.resolve(reply.result);
    });
    const command = (method: string, params: object) => new Promise<unknown>((resolve, reject) => {
      const id = ++sequence; pending.set(id, { resolve, reject }); socket!.send(JSON.stringify({ id, method, params }));
    });
    const evaluate = async (expression: string) => {
      const result = await command('Runtime.evaluate', { expression, returnByValue: true }) as { result: { value?: string }; exceptionDetails?: unknown };
      if (result.exceptionDetails) throw new Error(JSON.stringify(result.exceptionDetails));
      return result.result.value;
    };
    await command('Page.navigate', { url: pathToFileURL(join(directory, 'index.html')).href });
    for (;;) {
      const result = await evaluate('document.getElementById("result")?.textContent');
      if (result && result !== 'RUNNING') return (await evaluate('document.documentElement.outerHTML'))!;
      if (Date.now() > deadline) throw new Error(`Browser scenarios did not finish: ${await evaluate('document.body.dataset.scenario')}`);
      await tick();
    }
  } finally {
    socket?.close();
    child.kill();
    if (child.exitCode === null) await new Promise<void>((resolve) => child.once('exit', () => resolve()));
  }
}
