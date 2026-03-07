#!/usr/bin/env node

/**
 * cock terminal <id> <action> [args...]
 *
 * CLI 入口：访问运行中的终端气泡，获取输出、实时跟踪、发送输入。
 *
 * 用法示例：
 *   cock terminal list
 *   cock terminal abcd output
 *   cock terminal abcd follow
 *   cock terminal abcd stdin "hello"
 */

const args = process.argv.slice(2);

function printActions(prefix = '<id>') {
  console.log(`  list                        List all running terminals
  ${prefix} output               Get buffered output
  ${prefix} follow               Stream real-time output (Ctrl+C to stop)
  ${prefix} stdin <data>         Send input to process`);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: cock terminal <id> <action> [args...]\n\nCommands:');
  printActions();
  process.exit(0);
}

let id, action;

if (args[0] === 'list') {
  id = null;
  action = 'list';
} else {
  id = args[0];
  action = args[1];
  if (!action) {
    action = '_status';
  }
}

const extraArgs = args.slice(2);

const port = process.env.COCKPIT_PORT || 3457;
const baseUrl = `http://localhost:${port}`;

async function run() {
  // 只传 id 不传 action → 查状态 + 显示可用命令
  if (action === '_status') {
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
        const status = terminal.running ? '●' : '○';
        console.log(`${status} ${terminal.shortId}  pid=${terminal.pid}  ${terminal.command}`);
      } else {
        console.log(`○ ${id}  not found`);
      }
    } catch {
      console.log(`○ ${id}  server unreachable (${baseUrl})`);
    }
    console.log(`\nUsage: cock terminal ${id} <action>\n\nActions:`);
    printActions(id);
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
        console.log(`${status} ${t.shortId}  pid=${t.pid}  ${t.command}`);
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
        // 去掉所有 ANSI/VT100 转义序列，输出纯文本
        // eslint-disable-next-line no-control-regex
        const plain = data.data.output.replace(/\x1b\[[0-9;?]*[a-zA-Z]|\x1b\].*?(?:\x07|\x1b\\)|\x1b[()][AB012]|\x1b[>=]|\x1b[78]|\x07|\x08|\r/g, '');
        process.stdout.write(plain);
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
  printActions(id);
  process.exit(1);
}

export const done = run();
