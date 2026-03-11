#!/usr/bin/env node

/**
 * cock terminal <id> <action> [args...]
 *
 * CLI 入口：访问运行中的终端气泡，获取输出、实时跟踪、发送输入。
 */

const args = process.argv.slice(2);

// status: { running, command } — 传入时显示当前终端状态
function printHelp(prefix = '<id>', status = null) {
  console.log(`Interact with a running terminal process — read output, stream logs, and send input.

Usage: cock terminal ${prefix} <action>`);

  if (status) {
    if (status.running) {
      let line = `\nStatus: running`;
      if (status.command) line += `\n  command: ${status.command}`;
      console.log(line);
    } else {
      console.log(`\nStatus: not running`);
    }
  }

  console.log(`
Actions:
  output                    Get buffered output
  follow                    Stream real-time output (Ctrl+C to stop)
  stdin <data>              Send input to process

── Next step ──────────────────────────────────────────
Run \`cock terminal ${prefix} output\` to read the terminal output.
Use \`stdin\` to send commands or input to the process.

Example session:
  cock terminal ${prefix} output               # 1. read current output
  cock terminal ${prefix} stdin "ls -la"        # 2. send a command
  cock terminal ${prefix} output               # 3. read new output
  cock terminal ${prefix} follow               # stream output in real-time`);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  printHelp();
  process.exit(0);
}

let id, action;

if (args[0] === 'list') {
  id = null;
  action = 'list';
} else {
  id = args[0];
  action = args[1];
  if (!action || action === '--help' || action === '-h') {
    action = '_status';
  }
}

const extraArgs = args.slice(2);

const port = process.env.COCKPIT_PORT || 3457;
const baseUrl = `http://localhost:${port}`;

async function run() {
  // 只传 id 不传 action → 查状态 + 显示可用命令
  if (action === '_status') {
    let status = null;
    try {
      const res = await fetch(`${baseUrl}/api/terminal/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const terminal = data.ok && data.data?.find(t => t.shortId === id);
      if (terminal) {
        status = { running: terminal.running, command: terminal.command };
      }
    } catch {
      // server unreachable — show help without status
    }
    printHelp(id, status);
    return;
  }

  // list
  if (action === 'list') {
    try {
      const res = await fetch(`${baseUrl}/api/terminal/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!data.ok) { console.error(data.error); process.exit(1); }
      if (data.data.length === 0) { console.log('No running terminals'); return; }
      for (const t of data.data) {
        const status = t.running ? '●' : '○';
        console.log(`${status} ${t.shortId}  ${t.running ? 'running' : 'stopped'}  ${t.command}`);
      }
    } catch (err) {
      if (err.cause?.code === 'ECONNREFUSED') {
        console.error(`Connection refused: Cockpit server not running at ${baseUrl}`);
      } else {
        console.error(`Error: ${err.message}`);
      }
      process.exit(1);
    }
    return;
  }

  // output
  if (action === 'output') {
    try {
      const res = await fetch(`${baseUrl}/api/terminal/output`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
        signal: AbortSignal.timeout(10000),
      });
      const data = await res.json();
      if (!data.ok) { console.error(data.error); process.exit(1); }
      if (data.data.output) {
        process.stdout.write(data.data.output);
      }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // stdin
  if (action === 'stdin') {
    const inputData = extraArgs.join(' ');
    if (!inputData) {
      console.error('Usage: cock terminal <id> stdin <data>');
      process.exit(1);
    }
    try {
      const res = await fetch(`${baseUrl}/api/terminal/stdin`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, data: inputData + '\n' }),
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      if (!data.ok) { console.error(data.error); process.exit(1); }
    } catch (err) {
      console.error(`Error: ${err.message}`);
      process.exit(1);
    }
    return;
  }

  // follow (WebSocket 实时流)
  if (action === 'follow') {
    const { default: WebSocket } = await import('ws');
    const ws = new WebSocket(`ws://localhost:${port}/ws/terminal-follow?id=${id}`);

    ws.on('open', () => {
      // connected
    });

    ws.on('message', (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      if (msg.type === 'output') {
        process.stdout.write(msg.data);
      } else if (msg.type === 'exit') {
        console.log(`\n[exited: ${msg.code}]`);
        process.exit(msg.code || 0);
      }
      // ping 忽略
    });

    ws.on('close', () => process.exit(0));
    ws.on('error', (err) => {
      console.error(`WS error: ${err.message}`);
      process.exit(1);
    });

    // Ctrl+C 优雅退出
    process.on('SIGINT', () => {
      ws.close();
      process.exit(0);
    });

    // 保持进程活跃
    return new Promise(() => {});
  }

  console.error(`Unknown action: ${action}`);
  printHelp(id);
  process.exit(1);
}

export const done = run();
