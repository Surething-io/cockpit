#!/usr/bin/env node

/**
 * cock browser <id> <action> [args...]
 *
 * CLI 入口：解析参数，通过 HTTP API 发送命令到浏览器气泡，输出结果。
 *
 * 用法示例：
 *   cock browser abcd snapshot
 *   cock browser abcd navigate --url https://example.com
 *   cock browser abcd click --ref e5
 *   cock browser abcd type --ref e3 --text "hello"
 *   cock browser abcd evaluate --js "return document.title"
 *   cock browser abcd evaluate --all-frames --js "return document.title"
 *   cock browser abcd console --level error
 *   cock browser abcd network --status 4xx,5xx
 *   cock browser abcd assert --ref e5 --visible true
 *   cock browser abcd perf --metric timing
 *   cock browser abcd list   (列出所有已连接的浏览器)
 */

const args = process.argv.slice(2);

// 帮助文本（共用）
function printActions(prefix = '<id>') {
  console.log(`  list                              List all connected browsers

  Navigation:
  ${prefix} navigate <url>             Navigate to URL
  ${prefix} reload [--noCache]         Reload page
  ${prefix} back / forward             Navigate history
  ${prefix} url                        Get current URL
  ${prefix} title                      Get page title

  Inspection:
  ${prefix} snapshot                   Get accessibility tree
  ${prefix} screenshot                 Take a screenshot

  Interaction:
  ${prefix} click <ref>                Click element
  ${prefix} type <ref> <text>          Type text into element
  ${prefix} fill <ref> <value>         Fill input value
  ${prefix} hover <ref>                Hover element
  ${prefix} focus <ref>                Focus element
  ${prefix} scroll --direction D       Scroll page/element
  ${prefix} key <key>                  Press key (e.g. Enter, Ctrl+A)
  ${prefix} wait --text T              Wait for condition

  DOM:
  ${prefix} computed <ref>             Get computed styles
  ${prefix} bounds <ref>               Get element bounds
  ${prefix} attrs <ref>                Get element attributes
  ${prefix} events <ref>               Get event listeners
  ${prefix} evaluate <js>              Execute JavaScript (--all-frames)

  Network:
  ${prefix} network [--status S]       List requests (--method --type --clear)
  ${prefix} network_record start       Start recording body (--url --method --status --ttl)
  ${prefix} network_record stop        Stop recording
  ${prefix} network_record             Show recording status
  ${prefix} network_detail <id>        Get request/response detail

  Debug:
  ${prefix} console [--level L]        Get console messages (--clear)
  ${prefix} perf --metric M            Performance (timing|memory|resources)
  ${prefix} theme --mode M             Switch theme (dark|light)
  ${prefix} cookies                    Get cookies
  ${prefix} storage [--type T]         Get storage`);
}

if (args.length === 0 || args[0] === '--help' || args[0] === '-h') {
  console.log('Usage: cock browser <id> <action> [--flag value ...]\n\nCommands:');
  printActions();
  process.exit(0);
}

// 解析参数
let id, action;

if (args[0] === 'list') {
  id = null;
  action = 'list';
} else {
  id = args[0];
  action = args[1];

  if (!action || action === '--help' || action === '-h') {
    // 只传 id 不传 action（或传 --help）→ 显示状态 + 帮助
    action = '_status';
  }
}

// 解析 flags: --key value 对
function parseFlags(flagArgs) {
  const params = {};
  let i = 0;
  while (i < flagArgs.length) {
    const arg = flagArgs[i];
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = flagArgs[i + 1];

      // 布尔 flag（没有下一个参数，或下一个也是 --flag）
      if (!next || next.startsWith('--')) {
        params[key] = true;
        i++;
      } else {
        // 尝试解析为数字/boolean/JSON
        let value = next;
        if (value === 'true') value = true;
        else if (value === 'false') value = false;
        else if (/^\d+$/.test(value)) value = parseInt(value);
        else if (/^\d+\.\d+$/.test(value)) value = parseFloat(value);
        else {
          // 尝试 JSON 解析（数组、对象）
          try { value = JSON.parse(value); } catch { /* keep as string */ }
        }
        params[key] = value;
        i += 2;
      }
    } else {
      // 位置参数：第一个作为 ref 或 url 的快捷方式
      if (!params._positional) params._positional = [];
      params._positional.push(arg);
      i++;
    }
  }
  return params;
}

const params = parseFlags(args.slice(action === 'list' ? 1 : 2));

// 位置参数处理：某些命令的第一个位置参数有特殊含义
if (params._positional?.length) {
  const pos = params._positional;
  if (action === 'navigate' && !params.url) params.url = pos[0];
  if (action === 'click' && !params.ref) params.ref = pos[0];
  if (action === 'type' && !params.ref) { params.ref = pos[0]; if (pos[1] && !params.text) params.text = pos[1]; }
  if (action === 'fill' && !params.ref) { params.ref = pos[0]; if (pos[1] && !params.value) params.value = pos[1]; }
  if (action === 'hover' && !params.ref) params.ref = pos[0];
  if (action === 'focus' && !params.ref) params.ref = pos[0];
  if (action === 'evaluate' && !params.js) params.js = pos[0];
  // --all-frames → allFrames（kebab-case → camelCase）
  if (action === 'evaluate' && params['all-frames']) { params.allFrames = true; delete params['all-frames']; }
  if (action === 'wait' && !params.text && !params.ref && !params.url && !params.time) params.text = pos[0];
  if (action === 'computed' && !params.ref) params.ref = pos[0];
  if (action === 'bounds' && !params.ref) params.ref = pos[0];
  if (action === 'attrs' && !params.ref) params.ref = pos[0];
  if (action === 'events' && !params.ref) params.ref = pos[0];
  if (action === 'network_detail' && !params.id) params.id = parseInt(pos[0]);
  if (action === 'network_record' && !params.action) params.action = pos[0] || 'status';
  delete params._positional;
}

// 端口：cock-dev 会设 COCKPIT_PORT=3456，cock 默认 3457
const port = process.env.COCKPIT_PORT || 3457;
const baseUrl = `http://localhost:${port}`;
const timeout = params.timeout || 15000;
delete params.timeout;

// 发送请求
async function run() {
  // 只传 id 不传 action → 查状态 + 显示可用命令
  if (action === '_status') {
    try {
      const res = await fetch(`${baseUrl}/api/browser/list`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{}',
        signal: AbortSignal.timeout(5000),
      });
      const data = await res.json();
      const browser = data.ok && data.data?.find(b => b.shortId === id);
      if (browser) {
        console.log(`● ${browser.shortId}  ${browser.connected ? 'connected' : 'disconnected'}  ${browser.fullId}`);
      } else {
        console.log(`○ ${id}  not found`);
      }
    } catch {
      console.log(`○ ${id}  server unreachable (${baseUrl})`);
    }
    console.log(`\nUsage: cock browser ${id} <action>\n\nActions:`);
    printActions(id);
    return;
  }

  const url = `${baseUrl}/api/browser/${action}`;
  const body = { id, params, timeout };

  try {
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeout + 5000), // HTTP 超时比命令超时多 5s
    });

    const data = await response.json();

    if (!data.ok) {
      console.error(data.error || 'Unknown error');
      if (data.debug) console.error('Debug:', JSON.stringify(data.debug, null, 2));
      process.exit(1);
    }

    // 格式化输出
    await formatOutput(action, data.data);
  } catch (err) {
    if (err.name === 'TimeoutError' || err.code === 'ABORT_ERR') {
      console.error(`Timeout: No response within ${timeout}ms. Is the browser bubble connected?`);
    } else if (err.cause?.code === 'ECONNREFUSED') {
      console.error(`Connection refused: Cockpit server not running at ${baseUrl}`);
    } else {
      console.error(`Error: ${err.message}`);
    }
    process.exit(1);
  }
}

async function formatOutput(action, data) {
  if (data === undefined || data === null) {
    return;
  }

  // 特殊格式化
  switch (action) {
    case 'snapshot':
      // a11y tree 直接输出文本
      console.log(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
      return;

    case 'url':
    case 'title':
    case 'cookies':
      // 简单值直接输出
      console.log(data);
      return;

    case 'screenshot':
      if (data.image) {
        // data URL → 保存为 PNG 文件，输出路径（供 Read 工具查看）
        const { writeFileSync } = await import('fs');
        const { tmpdir } = await import('os');
        const { join } = await import('path');
        const base64 = data.image.replace(/^data:image\/\w+;base64,/, '');
        const filePath = join(tmpdir(), `cockpit-screenshot-${id}-${Date.now()}.png`);
        writeFileSync(filePath, Buffer.from(base64, 'base64'));
        console.log(filePath);
      } else {
        console.log(JSON.stringify(data, null, 2));
      }
      return;

    case 'list':
      if (Array.isArray(data) && data.length === 0) {
        console.log('No browsers connected');
        return;
      }
      if (Array.isArray(data)) {
        for (const b of data) {
          const status = b.connected ? '●' : '○';
          console.log(`${status} ${b.shortId}  ${b.fullId}`);
        }
        return;
      }
      break;

    case 'assert':
      if (data.pass) {
        console.log('PASS');
      } else {
        console.error('FAIL');
        for (const f of (data.failures || [])) {
          console.error(`  - ${f}`);
        }
        process.exit(1);
      }
      return;

    case 'console':
      if (Array.isArray(data)) {
        for (const m of data) {
          const ts = new Date(m.timestamp).toLocaleTimeString();
          console.log(`[${ts}] [${m.level}] ${m.text}`);
        }
        return;
      }
      break;

    case 'network':
      if (Array.isArray(data)) {
        for (const r of data) {
          const status = r.status || '???';
          const dur = r.duration ? `${r.duration}ms` : '...';
          const size = r.size ? ` ${r.size > 1024 ? (r.size / 1024).toFixed(1) + 'K' : r.size + 'B'}` : '';
          const rec = r.recorded ? ' ●' : '';
          console.log(`[${r.id}] ${r.method} ${r.url} ${status} ${dur}${size}${rec}`);
        }
        if (data.length === 0) console.log('(no requests)');
        return;
      }
      break;

    case 'network_record':
      if (data && !data.error) {
        if (data.recording === true && data.filters) {
          const filters = Object.entries(data.filters).map(([k, v]) => `${k}=${v}`).join(' ') || '(all)';
          console.log(`⏺ Recording started  filters: ${filters}  expires: ${data.expiresIn}`);
        } else if (data.recording === false && data.recordedCount !== undefined) {
          console.log(`⏹ Recording stopped  ${data.recordedCount} requests captured`);
        } else {
          // status
          const state = data.recording ? `⏺ Recording (${data.elapsed})` : '⏹ Stopped';
          const filters = data.filters && Object.keys(data.filters).length
            ? Object.entries(data.filters).map(([k, v]) => `${k}=${v}`).join(' ')
            : '(all)';
          console.log(`${state}  filters: ${filters}  recorded: ${data.recordedCount}/${data.totalCount}`);
        }
        return;
      }
      break;

    case 'network_detail':
      if (data && !data.error) {
        console.log(`${data.method} ${data.url}`);
        console.log(`Status: ${data.status}  Duration: ${data.duration}ms  Type: ${data.type}\n`);
        if (data.requestHeaders && Object.keys(data.requestHeaders).length) {
          console.log('--- Request Headers ---');
          for (const [k, v] of Object.entries(data.requestHeaders)) console.log(`  ${k}: ${v}`);
        }
        if (data.requestBody) {
          console.log('\n--- Request Body ---');
          console.log(data.requestBody);
        }
        if (data.responseHeaders && Object.keys(data.responseHeaders).length) {
          console.log('\n--- Response Headers ---');
          for (const [k, v] of Object.entries(data.responseHeaders)) console.log(`  ${k}: ${v}`);
        }
        if (data.responseBody) {
          console.log('\n--- Response Body ---');
          console.log(data.responseBody);
        }
        return;
      }
      break;
  }

  // 默认：JSON 输出
  if (typeof data === 'object') {
    console.log(JSON.stringify(data, null, 2));
  } else {
    console.log(data);
  }
}

// 导出 promise 以便 cock-dev.mjs await
export const done = run();
