/**
 * /html slash command — generate a Cockpit app: a local React page that runs
 * bash through the injected `window.cockpit` SDK.
 *
 * ONE mode: React on the locally-hosted zero-build stack (/html-lib). The
 * single-file inline-HTML fallback was deleted, not shrunk. It had grown into
 * the second-largest section while being the discouraged path, and — worse — it
 * had quietly become the only place the background-bash and dual-error-handling
 * examples lived, so readers of the default path had to mine the fallback for
 * them. Its removal is also what kills the "shared by both modes" hedging that
 * used to prefix every rule.
 *
 * Section order follows what a generator needs, not what a reader browses:
 * behaviour first (align → directory → confirm; nothing hits disk before that),
 * then a three-file skeleton to copy, then the SDK contract, then the data
 * layout, then theming.
 *
 * The skeleton is the load-bearing part. Rules that used to be prose — atomic
 * .tmp+rename, cache version, the refresh flag, the cached/updated stamp,
 * stale-fallback on a failed refresh — are baked into copyable code, because a
 * rule you copy is one you cannot half-implement. Prose recall was the actual
 * failure mode: apps that hand-rolled these each got a different subset right.
 *
 * The "local data" split exists because these pages are local *applications*,
 * not one-off views: without a storage convention every generated app refetched
 * on open, and the ones that did cache each invented their own layout — cache,
 * unrebuildable history and orphaned hand-maintained input ended up flat in one
 * directory, so nothing could tell you which files were safe to delete. Hence
 * one split by that exact question (cache/ rebuildable → gitignored, state/ not
 * rebuildable → committed, out/ artifacts), plus the caps that had to be
 * rediscovered per app (an unattended dump dir reached 611 MB, 84% of it three
 * files, with nothing that ever evicts). Backend-script
 * files, NOT localStorage — a snapshot can be hundreds of KB and the data is
 * produced where the fetching already happens.
 */

export const HTML_PROMPT_ZH = `---
name: html
description: "生成可交互的本地 React 应用：内置 cockpit bash SDK，执行命令取/改数据"
argument-hint: "描述你想要的应用"
---

# 生成 Cockpit 应用（本地 React 页面）

一个**本地应用**，不是一次性页面：预览时注入了全局 \`window.cockpit\` SDK —— 本质就是 Bash 工具
暴露给页面，按钮能 \`curl\`、读写文件、跑脚本；数据落盘在 app 目录里，重开即用。

零构建：React / Babel 从同源的 \`/html-lib\` 加载，不打包、不装依赖、离线可用。

## 一、流程：先对齐，确认后再写（重要）

**别一上来就写文件**，分三步：

1. **对齐需求** —— 先复述你对这个应用的理解（做什么、数据从哪来、关键功能与交互）。仅当需求有
   歧义或存在多种合理解读时才回问；已经清楚就直接给一段简短的理解摘要，不必逐条追问。
2. **告知存放目录** —— 定出 \`<目录>/<name>/\`，明确告诉用户准备存哪、叫什么名；用户可否决或改：
   - \`<name>\` **一律由你按需求起名**（短横线小写，与 \`cockpit-name\` 一致），用户只描述需求、
     不负责起名。
   - 用户在需求里给了目录 → \`<用户给的目录>/<name>/\`；没给 → **当前聊天工作目录**（本次会话的
     cwd）下的 \`<name>/\`。
   - 一个 app 的所有文件都在这个目录里，数据按第四节分到 \`cache/\` \`state/\` \`out/\`。别把文件
     散落到别处，也别自造 \`.cockpit-apps\` 之类目录。
3. **确认后才写** —— 等用户明确同意（确认 / 开始 / 写吧 / go 等任意肯定表示）再 \`Write\` 落盘。
   确认之前只讨论、不写文件。

即便用户在 \`/html\` 后已经把需求和目录都写清楚了，也要先停一轮，给出「理解 + 目录 + 一句『确认
就开始写?』」等待确认——但这一轮要**轻量**，别反复追问。

## 二、骨架：三个文件，照抄

\`index.html\` —— 外壳固定这样写，别自由发挥：

\`\`\`html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>页面标题</title>
  <meta name="cockpit-name" content="short-name">   <!-- /name 短名，唯一、只用字母数字-_ -->
  <meta name="description" content="一句话说明">
  <meta name="cockpit-icon" content="🔍">           <!-- emoji 或图标 url，可选 -->
  <meta name="cockpit-theme" content="auto">        <!-- 亮/暗切换，见第五节 -->
  <link rel="stylesheet" href="/html-lib/theme.css">
</head>
<body>
  <div id="root"></div>
  <script src="/html-lib/react.production.min.js"></script>
  <script src="/html-lib/react-dom.production.min.js"></script>
  <script src="/html-lib/babel.min.js"></script>
  <script>
    (async () => {
      const src = await (await fetch('./app.jsx')).text();
      // 必须 classic runtime：默认 automatic 会注入 import react/jsx-runtime，
      // 作为普通脚本注入会报 "Cannot use import statement outside a module"
      const { code } = Babel.transform(src, { presets: [['react', { runtime: 'classic' }]] });
      const s = document.createElement('script'); s.textContent = code; document.body.appendChild(s);
    })();
  </script>
</body>
</html>
\`\`\`

meta 头四行都要写：HTML 面板靠它做卡片，console 靠 \`cockpit-name\` 用 \`/name\` 打开。

\`app.jsx\` —— 全局 \`React\`，末尾 render。**打开只读缓存，点刷新才回源**：

\`\`\`jsx
const { useState, useEffect, useCallback } = React;

function App() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async (refresh) => {
    setBusy(true); setErr(null);
    try {
      const arg = btoa(JSON.stringify({ refresh: !!refresh }));       // 结构化入参走 base64
      const { stdout, stderr, exitCode } = await cockpit.bash(\`node ./api.mjs \${arg}\`);
      if (exitCode !== 0) throw new Error(stderr || '脚本失败');       // 命令跑了但失败
      const d = JSON.parse(stdout);
      if (d.error && !d.stale) throw new Error(d.error);
      setData(d);
      if (d.stale) setErr(d.error);                                   // 有旧数据可显示
    } catch (e) {
      setErr(e.message);        // 抛异常 = spawn/基建失败。已有 data 就留着，别清成错误页
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(false); }, [load]);        // 打开：只读缓存，0 次回源

  if (!data) return <div>{err ?? '加载中…'}</div>;
  return (
    <div>
      <span>{data.cached ? '缓存' : '已更新'} · {new Date(data.fetchedAt).toLocaleString('zh-CN')}</span>
      <button disabled={busy} onClick={() => load(true)}>{busy ? '刷新中…' : '刷新'}</button>
      {err && <em>刷新失败，下面是旧数据：{err}</em>}
      {/* 渲染 data */}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
\`\`\`

\`api.mjs\` —— 后端处理器：取数、解析、落盘都在这里，stdout 吐一个 JSON：

\`\`\`js
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE = join(DIR, 'cache/data.json');
const VERSION = 1;          // payload 结构一改就 bump，否则老缓存喂给新前端

const args = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString() || '{}');

function readCache() {
  if (!existsSync(CACHE)) return null;
  const c = JSON.parse(readFileSync(CACHE, 'utf8'));
  return c.v === VERSION ? c : null;          // 版本不符 = 作废，当没有
}
function writeCache(payload) {
  mkdirSync(dirname(CACHE), { recursive: true });
  const tmp = \`\${CACHE}.\${process.pid}.tmp\`;   // 原子写：中途被杀不会留下半个 JSON
  writeFileSync(tmp, JSON.stringify({ v: VERSION, fetchedAt: new Date().toISOString(), payload }));
  renameSync(tmp, CACHE);
}

try {
  const hit = args.refresh ? null : readCache();
  if (hit) {
    process.stdout.write(JSON.stringify({ ...hit.payload, cached: true, fetchedAt: hit.fetchedAt }));
  } else {
    const payload = await fetchFresh(args);   // ← 你的取数逻辑（curl / 查库 / 跑命令）
    writeCache(payload);
    process.stdout.write(JSON.stringify({ ...payload, cached: false, fetchedAt: new Date().toISOString() }));
  }
} catch (e) {
  const hit = readCache();                    // 刷新失败：回落旧缓存并标注，别让页面空掉
  process.stdout.write(JSON.stringify(hit
    ? { ...hit.payload, cached: true, stale: true, error: e.message, fetchedAt: hit.fetchedAt }
    : { error: e.message }));
}
\`\`\`

- 一条命令就够、数据也不值得留（纯查看当前状态）时，\`api.mjs\` 可以省掉，直接
  \`cockpit.bash("curl -s …")\`；但只要数据要留下来，就用这个骨架，别自己发明一套。
- 换语言同理：\`python3 ./api.py\` / \`bash ./api.sh\`（显式解释器，免 \`chmod +x\`）；\`node\` /
  \`python3\` 拿不准就先 \`command -v\` 探测，退回 shell。
- 缓存 key 要含**影响结果的参数**（时间范围、抓取深度…）：把 \`cache/data.json\` 换成
  \`cache/<param>.json\` 或在文件里按 key 分桶，否则会拿 7 天的缓存去渲染 30 天的视图。

## 三、契约：window.cockpit

页面加载时 SDK 已就绪，无需引入任何库：

- \`cockpit.cwd: string\` —— 当前文件所在目录，相对路径命令默认在此执行。
- \`cockpit.bash(command, opts?)\` —— 执行一条 bash 命令（\`command\` 是整条 shell 串）：
  - **前台**（默认，短/离散命令）→ \`Promise<{ stdout, stderr, exitCode }>\`，\`await\` 后一次拿全部输出。
  - **后台**（\`opts.background: true\`，长/实时命令）→ \`{ kill() }\`，经回调流式输出。
    大/持续输出**必须**用后台——前台会把输出全缓存在内存里。

\`\`\`js
const h = cockpit.bash("npm run build", {
  background: true,
  onOutput: c => append(c),
  onStderr: c => append(c),
  onExit:   code => append('\\n[退出 ' + code + ']'),   // 命令跑完了，code 非零 = 失败
  onError:  msg  => append('\\n[错误 ' + msg + ']'),    // spawn / 基建失败
});
// 组件卸载或用户中止时 h.kill()
\`\`\`

必守的几条：

1. **数据只走 \`cockpit.bash\`**（\`curl\` 取、\`curl -X POST\` 改、或读写文件），**绝不用
   \`fetch(外部URL)\`** —— 同源沙箱会 CORS 拦截。（\`fetch('./app.jsx')\` 这种同目录相对请求没问题。）
2. **两类失败都要处理**：\`try/catch\` 抓到的**抛异常 = spawn/基建失败**（坏路径、连接断）；没抛但
   **\`exitCode !== 0\` = 命令跑了但失败**，要展示 \`stderr\` 或 stdout 里的错误体，别只写"失败"。
   后台对应 \`onError\`（基建）+ \`onExit\` 非零 \`code\`（命令）。
3. **\`command\` 是 shell 串**：动态值/用户输入拼进去前必须校验或转义（shell 元字符会注入）；结构化
   入参一律走 base64（见骨架），别拼字符串；写库用**参数化**语句。
4. **资源引用**：同级相对（\`./app.jsx\`、\`./style.css\`、图片）和 CDN 绝对 URL 都能加载；根相对
   （\`/assets/x.css\`）会 404 —— 服务端只托管 \`/html-lib/*\` 和 \`/apps/*\`。

## 四、本地数据：三类目录

数据要落盘、要重开即用——**别每次打开都重新拉一遍**。所有持久化走 \`api.mjs\`，app 目录下按
「能不能重建」分三类，别平铺在一起：

- \`cache/\` —— 能重建的（接口返回、原始 dump、派生索引）。删了只是慢。**整目录写进 \`.gitignore\`**。
- \`state/\` —— 重建不出来的（每日快照、用户手工维护的清单）。源接口给不了第二次，删了永久丢。**入库**。
- \`out/\` —— 给人看的产物（报告、导出），按日期命名，留档。

分类的意义全在 git 策略上：目录分了但 \`cache/\` 没 ignore、\`state/\` 没入库，等于没分。

骨架里已经做掉的（版本号、原子写、\`refresh\` 参数、取数时间戳、失败回落旧数据）不再重复，剩下这些
要你自己守：

1. **会增长的目录必须有上限，并在脚本里执行**（留 N 条 / 超 X MB 就清）。只写在注释里的上限等于
   没有，没人看管的 dump 目录涨到 GB 级是常态。
2. **落盘文件里不写绝对路径**（存相对 app 目录的路径），否则目录一挪索引全废；含邮箱等隐私的落盘
   一律 ignore。
3. **留一个清空入口**（\`api.mjs\` 加个 \`clear_cache\` 模式 + 界面按钮），否则用户只能去文件管理器里
   猜哪个文件能删。
4. 要用别的 app 的凭据 / 工具脚本时走 \`../<app>/\` 相对引用，并**先探测存在再用**；失败给一句照着做
   就能修的提示（「去 xxx 重新登录」），别把原始报错甩给用户。

## 五、主题

样式默认套 **Cockpit 主题**（\`index.html\` 里已经 link 了 \`/html-lib/theme.css\`）。**配色动手前先拉
一次这份文件**，它是变量的唯一真源，别凭记忆猜变量名：

\`\`\`bash
curl -fsS "{{BASE_URL}}/html-lib/theme.css"
\`\`\`

- \`:root\` 段是亮色取值、\`.dark\` 段是暗色。原始色阶（\`--slate-*\` / \`--teal-*\` / \`--red-*\` …）存的是
  HSL 分量，所以半透明直接写 \`hsl(var(--green-9) / .12)\`。
- 前景色成对取（\`--card\`/\`--card-foreground\` …），**只有 \`--brand\` 是坑**：\`--brand-foreground\` 是
  同色系色调，压在 \`--brand\` 填充上仅 1.5:1；**brand 填充上的文字改用 \`var(--background)\`**。
- \`cockpit-theme\` meta 让预览带一个浮动亮/暗切换按钮（默认右上角，用户可拖动吸附到任意一角，所以
  不必为它在右上角留空位）；**默认跟随 Cockpit 宿主主题**（Cockpit 外打开时按 meta 的
  auto/light/dark），手动切换后**按 app 记住选择（跨刷新，优先于跟随）**，也可调
  \`cockpit.toggleTheme()\`。
- **别自拍调色板、别上 Tailwind**；app 特有细节再补一小段 \`<style>\`。`

export const HTML_PROMPT_EN = `---
name: html
description: "Generate an interactive local React app with the built-in cockpit bash SDK to fetch/update data"
argument-hint: "describe the app you want"
---

# Build a Cockpit app (a local React page)

A **local application**, not a one-off page: the preview injects a global \`window.cockpit\`
SDK — essentially the Bash tool exposed to the page, so buttons can \`curl\`, read/write files
and run scripts; data lands on disk inside the app directory and is there on reopen.

Zero build: React / Babel load from the same-origin \`/html-lib\` — no bundler, no deps, works offline.

## 1. Flow: align first, write only after confirmation (important)

**Don't write files up front.** Three steps:

1. **Align on the requirement** — restate your understanding of the app (what it does, where
   data comes from, key features/interactions). Ask back only when the requirement is ambiguous
   or has several reasonable readings; if it's already clear, just give a short summary — don't
   interrogate.
2. **Tell the storage directory** — resolve \`<dir>/<name>/\` and tell the user exactly where it
   goes and what it's called; they may reject or change it:
   - **You always pick \`<name>\`** from the request (lowercase kebab-case, matching
     \`cockpit-name\`) — the user only describes the app, they don't name it.
   - The user gave a directory → \`<the given directory>/<name>/\`; none given → \`<name>/\` under
     the **current chat working directory** (this session's cwd).
   - Every file of the app lives in that one directory, with data split into \`cache/\`
     \`state/\` \`out/\` per section 4. Don't scatter files elsewhere or invent a \`.cockpit-apps\`.
3. **Write only after confirmation** — \`Write\` the files once the user clearly agrees (confirm /
   start / go / "write it" — any affirmative). Until then, only discuss.

Even if the user already spelled out requirement and directory in the \`/html\` call, still stop
once to present "understanding + directory + a 'shall I start writing?'" and wait — but keep that
round **lightweight**, don't re-interrogate.

## 2. Skeleton: three files, copy them

\`index.html\` — use this fixed shell, don't improvise:

\`\`\`html
<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <title>Page title</title>
  <meta name="cockpit-name" content="short-name">   <!-- unique short name for /name; letters/digits/-_ -->
  <meta name="description" content="one line about the page">
  <meta name="cockpit-icon" content="🔍">           <!-- emoji or icon url, optional -->
  <meta name="cockpit-theme" content="auto">        <!-- light/dark toggle, see section 5 -->
  <link rel="stylesheet" href="/html-lib/theme.css">
</head>
<body>
  <div id="root"></div>
  <script src="/html-lib/react.production.min.js"></script>
  <script src="/html-lib/react-dom.production.min.js"></script>
  <script src="/html-lib/babel.min.js"></script>
  <script>
    (async () => {
      const src = await (await fetch('./app.jsx')).text();
      // MUST use classic runtime: the default automatic runtime injects an import of
      // react/jsx-runtime, which — appended as a plain script — throws
      // "Cannot use import statement outside a module".
      const { code } = Babel.transform(src, { presets: [['react', { runtime: 'classic' }]] });
      const s = document.createElement('script'); s.textContent = code; document.body.appendChild(s);
    })();
  </script>
</body>
</html>
\`\`\`

All four meta lines matter: the HTML panel renders cards from them, and the console opens the
app via \`cockpit-name\` (\`/name\`).

\`app.jsx\` — global \`React\`, render at the end. **Opening reads the cache; only Refresh goes out**:

\`\`\`jsx
const { useState, useEffect, useCallback } = React;

function App() {
  const [data, setData] = useState(null);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState(null);

  const load = useCallback(async (refresh) => {
    setBusy(true); setErr(null);
    try {
      const arg = btoa(JSON.stringify({ refresh: !!refresh }));      // structured args as base64
      const { stdout, stderr, exitCode } = await cockpit.bash(\`node ./api.mjs \${arg}\`);
      if (exitCode !== 0) throw new Error(stderr || 'script failed');  // ran, but failed
      const d = JSON.parse(stdout);
      if (d.error && !d.stale) throw new Error(d.error);
      setData(d);
      if (d.stale) setErr(d.error);                                  // old data is still shown
    } catch (e) {
      setErr(e.message);      // a throw = spawn/infra failure. Keep existing data on screen
    } finally { setBusy(false); }
  }, []);

  useEffect(() => { load(false); }, [load]);       // on open: cache only, zero requests

  if (!data) return <div>{err ?? 'Loading…'}</div>;
  return (
    <div>
      <span>{data.cached ? 'cached' : 'updated'} · {new Date(data.fetchedAt).toLocaleString()}</span>
      <button disabled={busy} onClick={() => load(true)}>{busy ? 'Refreshing…' : 'Refresh'}</button>
      {err && <em>Refresh failed, showing older data: {err}</em>}
      {/* render data */}
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')).render(<App />);
\`\`\`

\`api.mjs\` — the backend handler: fetching, parsing and persistence live here; one JSON on stdout:

\`\`\`js
import { existsSync, readFileSync, writeFileSync, renameSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = dirname(fileURLToPath(import.meta.url));
const CACHE = join(DIR, 'cache/data.json');
const VERSION = 1;          // bump whenever the payload shape changes, or old cache feeds a new UI

const args = JSON.parse(Buffer.from(process.argv[2] || '', 'base64').toString() || '{}');

function readCache() {
  if (!existsSync(CACHE)) return null;
  const c = JSON.parse(readFileSync(CACHE, 'utf8'));
  return c.v === VERSION ? c : null;          // version mismatch = void it, act as if empty
}
function writeCache(payload) {
  mkdirSync(dirname(CACHE), { recursive: true });
  const tmp = \`\${CACHE}.\${process.pid}.tmp\`;   // atomic: a kill mid-write leaves no half JSON
  writeFileSync(tmp, JSON.stringify({ v: VERSION, fetchedAt: new Date().toISOString(), payload }));
  renameSync(tmp, CACHE);
}

try {
  const hit = args.refresh ? null : readCache();
  if (hit) {
    process.stdout.write(JSON.stringify({ ...hit.payload, cached: true, fetchedAt: hit.fetchedAt }));
  } else {
    const payload = await fetchFresh(args);   // ← your fetching logic (curl / DB / commands)
    writeCache(payload);
    process.stdout.write(JSON.stringify({ ...payload, cached: false, fetchedAt: new Date().toISOString() }));
  }
} catch (e) {
  const hit = readCache();                    // failed refresh: fall back to the old cache, labelled
  process.stdout.write(JSON.stringify(hit
    ? { ...hit.payload, cached: true, stale: true, error: e.message, fetchedAt: hit.fetchedAt }
    : { error: e.message }));
}
\`\`\`

- When one command is enough and the data isn't worth keeping (just viewing current state), skip
  \`api.mjs\` and call \`cockpit.bash("curl -s …")\` directly. The moment data should survive a
  reopen, use this skeleton rather than inventing your own.
- Same for other languages: \`python3 ./api.py\` / \`bash ./api.sh\` (explicit interpreter avoids
  \`chmod +x\`); probe \`node\` / \`python3\` with \`command -v\` if unsure and fall back to shell.
- The cache key must include **every parameter that changes the result** (time range, fetch depth
  …): use \`cache/<param>.json\` or bucket by key inside the file — otherwise a 7-day cache renders
  in the 30-day view.

## 3. Contract: window.cockpit

The SDK is ready on load — no library to import:

- \`cockpit.cwd: string\` — directory of the current file; relative-path commands run here.
- \`cockpit.bash(command, opts?)\` — run one bash command (\`command\` is a raw shell string):
  - **Foreground** (default, short/discrete) → \`Promise<{ stdout, stderr, exitCode }>\`; \`await\` for the full output at once.
  - **Background** (\`opts.background: true\`, long/live) → \`{ kill() }\`, streaming via callbacks.
    Large/continuous output **must** use background — foreground buffers it all in memory.

\`\`\`js
const h = cockpit.bash("npm run build", {
  background: true,
  onOutput: c => append(c),
  onStderr: c => append(c),
  onExit:   code => append('\\n[exit ' + code + ']'),   // command finished; non-zero = failed
  onError:  msg  => append('\\n[error ' + msg + ']'),   // spawn / infra failure
});
// h.kill() on unmount or when the user aborts
\`\`\`

Rules every page must follow:

1. **Data only through \`cockpit.bash\`** (\`curl\` to read, \`curl -X POST\` to write, or read/write
   files) — **never \`fetch(externalURL)\`**: the same-origin sandbox blocks it via CORS.
   (\`fetch('./app.jsx')\` and other same-directory relative requests are fine.)
2. **Handle both failure modes**: a **throw** caught by \`try/catch\` = spawn/infra failure (bad
   path, dropped connection); no throw but **\`exitCode !== 0\` = the command ran and failed** — show
   \`stderr\` or the error body in stdout, don't just say "failed". Background: \`onError\` (infra) +
   a non-zero \`code\` in \`onExit\` (command).
3. **\`command\` is a shell string**: validate or escape any dynamic/user input before interpolating
   it (shell metacharacters inject); pass structured input as base64 (see the skeleton) instead of
   string-building; use **parameterized** statements for DB writes.
4. **Resource refs**: relative siblings (\`./app.jsx\`, \`./style.css\`, images) and absolute CDN URLs
   load; root-relative (\`/assets/x.css\`) 404s — the server only hosts \`/html-lib/*\` and \`/apps/*\`.

## 4. Local data: three directories

Data must land on disk and be there on reopen — **don't refetch everything on every open**. All
persistence goes through \`api.mjs\`; inside the app directory, split it by "can this be rebuilt?"
into three directories instead of one flat pile:

- \`cache/\` — rebuildable (API responses, raw dumps, derived indexes). Deleting it only costs time. **Gitignore the whole directory.**
- \`state/\` — NOT rebuildable (daily snapshots, hand-maintained lists). The source can't hand it to you twice; deleted means gone. **Commit it.**
- \`out/\` — artifacts for humans (reports, exports), date-named, kept.

The split only pays off through the git policy: directories separated but \`cache/\` not ignored and
\`state/\` not committed means nothing was separated.

What the skeleton already handles (versioning, atomic writes, the \`refresh\` flag, the fetch
timestamp, stale fallback) isn't repeated here. What's left is on you:

1. **Any growing directory needs a cap enforced in the script** (keep N entries / prune past X MB).
   A cap that lives only in a comment is not a cap — unattended dump directories reach GB scale.
2. **Never write absolute paths into a file on disk** (store paths relative to the app directory),
   or moving the directory voids the index; anything holding private data (emails …) is gitignored.
3. **Provide a clear/reset entry point** (a \`clear_cache\` mode in \`api.mjs\` + a button), or the
   user's only option is guessing which file is safe to delete in a file manager.
4. To use another app's credentials / helper scripts, reference them as \`../<app>/\` and **probe
   that they exist first**; on failure give one actionable line ("log in again at xxx") rather than
   dumping the raw error.

## 5. Theme

Style with the **Cockpit theme** by default (\`index.html\` already links \`/html-lib/theme.css\`).
**Fetch that file once before you pick any colour** — it is the single source of truth for the
variables, so don't guess names from memory:

\`\`\`bash
curl -fsS "{{BASE_URL}}/html-lib/theme.css"
\`\`\`

- \`:root\` holds the light values, \`.dark\` the dark ones. The raw scales (\`--slate-*\` / \`--teal-*\` /
  \`--red-*\` …) store HSL components, so translucency is just \`hsl(var(--green-9) / .12)\`.
- Take foregrounds in pairs (\`--card\`/\`--card-foreground\` …), **except \`--brand\`**:
  \`--brand-foreground\` is a tint of the same hue and hits only 1.5:1 on a \`--brand\` fill — **use
  \`var(--background)\` for text on a brand fill**.
- The \`cockpit-theme\` meta gives the preview a floating light/dark toggle (top-right by default,
  draggable to any corner — so don't reserve top-right space for it); it **follows the Cockpit host
  theme by default** (outside Cockpit, the meta's auto/light/dark decides), and a manual toggle is
  **remembered per app across reloads and overrides the host**, or call \`cockpit.toggleTheme()\`.
- **Don't invent a palette or add Tailwind**; add a small \`<style>\` for app-specific bits.`
