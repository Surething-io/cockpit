import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Real compositor frames are required to test viewport acknowledgements. */
export async function captureBrowserDom(browser: string, directory: string, url = pathToFileURL(join(directory, 'index.html')).href, signal?: AbortSignal): Promise<string> {
  signal?.throwIfAborted();
  const profile = join(directory, 'profile');
  const child = spawn(browser, ['--headless', '--disable-gpu', '--no-sandbox', '--no-first-run', '--disable-background-networking', '--password-store=basic', '--use-mock-keychain',
    '--remote-debugging-port=0', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  // Register immediately: exitCode stays null when Chrome exits from a signal.
  const closed = new Promise<void>((resolve) => child.once('close', () => resolve()));
  let socket: WebSocket | undefined;
  let stopped = false;
  const deadline = Date.now() + 45_000;
  const tick = () => new Promise((resolve) => setTimeout(resolve, 25));
  let timer: ReturnType<typeof setTimeout>;
  let onAbort: () => void;
  const interrupted = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error('Browser capture timed out after 45000ms')), 45_000);
    onAbort = () => reject(signal!.reason);
    signal?.addEventListener('abort', onAbort, { once: true });
    child.once('error', reject);
  });
  const capture = async (): Promise<string> => {
    let port = '';
    while (!port) {
      if (child.exitCode !== null || child.signalCode !== null || Date.now() > deadline) throw new Error('Isolated browser did not start');
      port = await readFile(join(profile, 'DevToolsActivePort'), 'utf8').then((text) => text.split('\n')[0], () => '');
      if (!port) await tick();
    }
    if (stopped) throw new Error('Browser capture stopped');
    const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json() as { webSocketDebuggerUrl: string; type: string }[];
    if (stopped) throw new Error('Browser capture stopped');
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
    await command('Page.enable', {});
    // Navigation returns before the new execution context is ready for evaluation.
    const loaded = new Promise<void>((resolve) => {
      const onMessage = (event: MessageEvent) => {
        if (JSON.parse(String(event.data)).method !== 'Page.loadEventFired') return;
        socket!.removeEventListener('message', onMessage);
        resolve();
      };
      socket!.addEventListener('message', onMessage);
    });
    await command('Page.navigate', { url });
    await loaded;
    for (;;) {
      const result = await evaluate('document.getElementById("result")?.textContent');
      if (result && result !== 'RUNNING') return (await evaluate('document.documentElement.outerHTML'))!;
      if (Date.now() > deadline) throw new Error(`Browser scenarios did not finish: ${await evaluate('document.body.dataset.scenario')}`);
      await tick();
    }
  };
  try {
    // Bound every stage, including debugger connection, navigation and commands.
    return await Promise.race([capture(), interrupted]);
  } finally {
    stopped = true;
    clearTimeout(timer!);
    signal?.removeEventListener('abort', onAbort!);
    socket?.close();
    if (child.exitCode === null && child.signalCode === null) child.kill();
    const forceKill = setTimeout(() => child.kill('SIGKILL'), 2000);
    try { await closed; } finally { clearTimeout(forceKill); }
  }
}
