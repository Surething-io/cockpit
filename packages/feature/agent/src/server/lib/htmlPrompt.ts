/**
 * /html slash command — generate a Cockpit "small app": an interactive
 * page that runs bash via the injected `window.cockpit` SDK.
 *
 * Default mode is React (zero-build, served from the locally-hosted /html-lib);
 * plain single-file HTML is the fallback for trivial/static pages. Both modes
 * share one contract: fetch/update data through `cockpit.bash('curl ...')`,
 * never `fetch(externalURL)` (the same-origin sandbox blocks it via CORS).
 *
 * Structure: intro (+ mode choice) → align-then-confirm flow (no write until the
 * user OKs the requirement + directory) → shared window.cockpit contract (stated
 * once) → React default → CGI backend → HTML fallback (holds the plain examples).
 */

export const HTML_PROMPT_ZH = `---
name: html
description: "生成可交互的小应用：内置 cockpit bash SDK，执行命令取/改数据"
argument-hint: "描述你想要的小应用"
---

# 生成 Cockpit 小应用

一个能取/改数据的小应用：预览时注入了全局 \`window.cockpit\` SDK —— 本质就是 Bash
工具暴露给页面，页面按钮能 \`curl\`、读写文件、跑脚本。

**默认用 React 写**（下面的本地零构建栈，productized、AI 最熟，适合有状态 / 多视图 /
表单）；只有**极简单的单视图、或纯静态一次性页**才退回单文件内联 HTML。两种模式共用下面
这套契约。

## 流程：先对齐，确认后再写（重要）

**别一上来就写文件**，分三步：

1. **对齐需求** —— 先复述你对这个小应用的理解（做什么、用 React 还是单文件、数据从哪来、
   关键功能与交互）。仅当需求有歧义或存在多种合理解读时才回问；已经清楚就直接给一段简短
   的理解摘要，不必逐条追问。
2. **告知存放目录** —— 按下面「存放位置」规则定出 \`<目录>/<name>/\`，明确告诉用户准备存哪、
   叫什么名；用户可否决或改目录 / 改名。
3. **确认后才写** —— 等用户明确同意（确认 / 开始 / 写吧 / go 等任意肯定表示）再 \`Write\`
   落盘。确认之前只讨论、不写文件。

即便用户在 \`/html\` 后已经把需求和目录都写清楚了，也要先停一轮，给出「理解 + 目录 + 一句
『确认就开始写?』」等待确认——但这一轮要**轻量**，别反复追问。

## 契约：window.cockpit（两模式共用，只此一处）

页面加载时 SDK 已就绪，无需引入任何库：

- \`cockpit.cwd: string\` —— 当前文件所在目录，相对路径命令默认在此执行。
- \`cockpit.bash(command, opts?)\` —— 执行一条 bash 命令（\`command\` 是整条 shell 串）：
  - **前台**（默认，短/离散命令）→ \`Promise<{ stdout, stderr, exitCode }>\`，\`await\` 后一次性拿全部输出。
  - **后台**（\`opts.background: true\`，长/实时命令）→ \`{ kill() }\`，经回调流式输出：
    \`opts = { background:true, cwd?, onOutput?, onStderr?, onExit?, onError? }\`。大/持续输出必须用后台（前台全缓存在内存）。

写这类页面必须守的几条：

1. **数据只走 \`cockpit.bash\`**（\`curl\` 取、\`curl -X POST\` 改、或读写文件），**绝不用
   \`fetch(外部URL)\`** —— 同源沙箱会 CORS 拦截。
2. **两类失败都要处理**（前台）：\`try/catch\` 抓到的**抛异常 = spawn/基建失败**（坏路径、
   连接断）；没抛但 **\`exitCode !== 0\` = 命令跑了但失败**，展示 \`stderr\` 或 stdout 里的错误
   体，别只写"失败"。后台对应 \`onError\`（基建）+ \`onExit\` 非零 \`code\`（命令）。
3. **\`command\` 是 shell 串**：动态值/用户输入拼进去前必须校验或转义（shell 元字符会注入）；
   能用固定命令就别裸拼。
4. **资源引用**：同级相对（\`./app.jsx\`、\`./style.css\`、图片）和 CDN 绝对 URL 都能加载；根
   相对（\`/assets/x.css\`）会 404。

meta 头（务必写上，供 HTML 面板做卡片、console \`/name\` 打开）：

\`\`\`html
<title>页面标题</title>
<meta name="cockpit-name" content="short-name">   <!-- /name 短名，唯一、只用字母数字-_ -->
<meta name="description" content="一句话说明">
<meta name="cockpit-icon" content="🔍">           <!-- emoji 或图标 url，可选 -->
<meta name="cockpit-theme" content="auto">        <!-- 启用可拖动的亮/暗切换按钮；auto=首次跟随系统，可填 light/dark -->
\`\`\`

## 默认：React（本地零构建栈）

外壳固定这样写，逻辑拆到同级 \`./app.jsx\`：

\`\`\`html
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
\`\`\`

- \`/html-lib\` 是 Cockpit 本地托管（同源、离线可用，无需 CDN）。
- \`app.jsx\` 用全局 \`React\`（\`const { useState } = React;\`），末尾
  \`ReactDOM.createRoot(document.getElementById('root')).render(<App/>)\`。
- 样式默认套 **Cockpit 主题**：\`<link rel="stylesheet" href="/html-lib/theme.css">\`，直接用
  语义变量（\`var(--background)\` / \`--foreground\` / \`--card\` / \`--brand\` / \`--muted-foreground\` /
  \`--border\` / \`--destructive\`；半透明用 \`hsl(var(--green-9) / .12)\`）。上面 meta 头里的
  \`cockpit-theme\` 让预览带上一个浮动亮/暗切换按钮（默认右上角，用户可拖动吸附到任意一角，
  所以不必为它在右上角留空位）；**默认跟随 Cockpit 宿主主题**（Cockpit 外打开时按
  meta 的 auto/light/dark），手动切换后**按 app 记住选择（跨刷新，优先于跟随）**，也可调
  \`cockpit.toggleTheme()\`。**别自拍调色板、别上 Tailwind**；app 特有细节再补一小段 \`<style>\`。

React 里取数同样走 \`cockpit.bash\`：

\`\`\`jsx
function App() {
  const [stars, setStars] = React.useState(null);
  const load = async () => {
    const { stdout, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
    setStars(exitCode === 0 ? JSON.parse(stdout).stargazers_count : '出错');
  };
  return <button onClick={load}>⭐ {stars ?? '加载'}</button>;
}
\`\`\`

## 后端：复杂逻辑写成脚本（CGI 风格，两模式通用）

命令很短就内联在 \`cockpit.bash("...")\`；逻辑复杂（多步、解析、循环、要库、写库）时，把后端
写成同目录**脚本文件**，\`cockpit.bash\` 调它——HTML/JSX 管展示，脚本当后端处理器。

- **显式解释器**：\`cockpit.bash("node ./api.mjs")\` / \`python3 ./api.py\` / \`bash ./api.sh\`
  （免 \`chmod +x\`）；\`node\`/\`python3\` 拿不准就先 \`command -v\` 探测，退回 shell。
- **传参防注入**：结构化入参用 **base64** 传（前端 \`btoa(...)\`、脚本
  \`Buffer.from(arg,'base64')\`），别拼字符串；写库用**参数化**语句。
- 脚本用 stdout 返回 JSON，前端 \`JSON.parse\`。先 \`Write\` 出脚本，再在页面调它。

## 退回：单文件 HTML（极简 / 纯静态一次性页）

不需要状态就别上 React，直接内联；取数与错误处理同上。

前台（点按钮拉数据）：

\`\`\`html
<button id="load">加载</button>
<pre id="out"></pre>
<script>
  document.getElementById('load').onclick = async () => {
    try {
      const { stdout, stderr, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
      if (exitCode !== 0) { out.textContent = '命令失败: ' + stderr; return; }
      out.textContent = '⭐ ' + JSON.parse(stdout).stargazers_count;
    } catch (e) {
      out.textContent = '执行出错: ' + e.message;  // spawn / 基建失败
    }
  };
</script>
\`\`\`

后台（实时日志）：

\`\`\`html
<pre id="log"></pre>
<script>
  const box = document.getElementById('log');
  const h = cockpit.bash("tail -f ./build.log", {
    background: true,
    onOutput: c => { box.textContent += c; },
    onExit:   code => { box.textContent += '\\n[退出 ' + code + ']'; },
    onError:  msg  => { box.textContent += '\\n[错误 ' + msg + ']'; },
  });
  // 需要时 h.kill()
</script>
\`\`\`

## 存放位置

一个 app 的所有文件（\`index.html\` + \`app.jsx\` + \`api.mjs\` …）放进同一个 \`<name>/\`
子目录。\`<name>\` **一律由你按需求起名**（短横线小写，与 \`cockpit-name\` 一致），用户只
描述需求、不负责起名。目标目录按下面规则确定：

- 用户在需求里给了目录 → 存到 \`<用户给的目录>/<name>/\`
- 用户没给 → 存到**当前聊天工作目录**（本次会话的 cwd）下的 \`<name>/\`

别把文件散落到别处或自造 \`.cockpit-apps\` 之类目录。这个目录就是上面「流程」第 2 步要告知用户的；**用户确认后**再用 \`Write\` 写出，用户点击
即可预览并交互。`

export const HTML_PROMPT_EN = `---
name: html
description: "Generate an interactive small app with the built-in cockpit bash SDK to fetch/update data"
argument-hint: "describe the small app you want"
---

# Build a Cockpit small app

A small app that can fetch/update data: the preview injects a global
\`window.cockpit\` SDK — essentially the Bash tool exposed to the page, so buttons can
\`curl\`, read/write files, and run scripts.

**Default to React** (the local zero-build stack below — productized, most AI-familiar,
ideal for stateful / multi-view / form apps); fall back to single-file inline HTML only
for a **trivial single view or a purely static one-off**. Both modes share the one
contract below.

## Flow: align first, write only after confirmation (important)

**Don't write files up front.** Three steps:

1. **Align on the requirement** — restate your understanding of the app (what it does,
   React vs single-file, where data comes from, key features/interactions). Ask back only
   when the requirement is ambiguous or has several reasonable readings; if it's already
   clear, just give a short understanding summary — don't interrogate.
2. **Tell the storage directory** — resolve \`<dir>/<name>/\` per the "Where to store" rules
   below and tell the user exactly where it'll go and what it's named; the user may reject
   or change the directory / name.
3. **Write only after confirmation** — \`Write\` the files only once the user clearly agrees
   (confirm / start / go / "write it" — any affirmative). Until then, only discuss — write
   nothing to disk.

Even if the user already spelled out the requirement and directory in the \`/html\` call,
still stop once to present "understanding + directory + a 'shall I start writing?'" and
wait — but keep this round **lightweight**, don't re-interrogate.

## Contract: window.cockpit (shared by both modes, stated once)

The SDK is ready on load — no library to import:

- \`cockpit.cwd: string\` — directory of the current file; relative-path commands run here.
- \`cockpit.bash(command, opts?)\` — run one bash command (\`command\` is a raw shell string):
  - **Foreground** (default, short/discrete) → \`Promise<{ stdout, stderr, exitCode }>\`; \`await\` for the full output at once.
  - **Background** (\`opts.background: true\`, long/live) → \`{ kill() }\`, streaming via callbacks:
    \`opts = { background:true, cwd?, onOutput?, onStderr?, onExit?, onError? }\`. Use background for large/continuous output (foreground buffers it all in memory).

Rules every such page must follow:

1. **Data only through \`cockpit.bash\`** (\`curl\` to read, \`curl -X POST\` to write, or
   read/write files) — **never \`fetch(externalURL)\`**: the same-origin sandbox blocks it via CORS.
2. **Handle both failure modes** (foreground): a **throw** caught by \`try/catch\` = spawn/infra
   failure (bad path, dropped connection); no throw but **\`exitCode !== 0\` = the command ran
   and failed** — show \`stderr\` or the error body in stdout, don't just say "failed". Background:
   \`onError\` (infra) + a non-zero \`code\` in \`onExit\` (command).
3. **\`command\` is a shell string**: validate or escape any dynamic/user input before
   interpolating it (shell metacharacters inject); prefer a fixed command.
4. **Resource refs**: relative siblings (\`./app.jsx\`, \`./style.css\`, images) and absolute
   CDN URLs load; root-relative (\`/assets/x.css\`) 404s.

Meta head (always include — the HTML panel renders cards from it, the console opens it via \`/name\`):

\`\`\`html
<title>Page title</title>
<meta name="cockpit-name" content="short-name">   <!-- unique short name for /name; letters/digits/-_ only -->
<meta name="description" content="one line about the page">
<meta name="cockpit-icon" content="🔍">           <!-- emoji or icon url, optional -->
<meta name="cockpit-theme" content="auto">        <!-- enable the draggable light/dark toggle; auto = first load follows the OS, or light/dark -->
\`\`\`

## Default: React (local zero-build stack)

Use this fixed shell, with the logic in a sibling \`./app.jsx\`:

\`\`\`html
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
\`\`\`

- \`/html-lib\` is hosted locally by Cockpit (same-origin, offline, no CDN).
- \`app.jsx\` uses the global \`React\` (\`const { useState } = React;\`) and ends with
  \`ReactDOM.createRoot(document.getElementById('root')).render(<App/>)\`.
- Style with the **Cockpit theme** by default: \`<link rel="stylesheet" href="/html-lib/theme.css">\`,
  then use the semantic vars (\`var(--background)\` / \`--foreground\` / \`--card\` / \`--brand\` /
  \`--muted-foreground\` / \`--border\` / \`--destructive\`; translucency via \`hsl(var(--green-9) / .12)\`).
  The \`cockpit-theme\` meta above gives the preview a floating light/dark toggle (top-right by
  default, draggable to any corner — so don't reserve top-right space for it); it **follows the
  Cockpit host theme by default** (outside Cockpit, the meta's auto/light/dark decides), and a manual
  toggle is **remembered per app across reloads and overrides the host**, or call \`cockpit.toggleTheme()\`
  from your own UI. Don't invent a palette or add Tailwind; add a small \`<style>\` for app-specific bits.

Fetch data from React the same way, via \`cockpit.bash\`:

\`\`\`jsx
function App() {
  const [stars, setStars] = React.useState(null);
  const load = async () => {
    const { stdout, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
    setStars(exitCode === 0 ? JSON.parse(stdout).stargazers_count : 'error');
  };
  return <button onClick={load}>⭐ {stars ?? 'load'}</button>;
}
\`\`\`

## Backend: write complex logic as a script (CGI-style, both modes)

Inline short commands in \`cockpit.bash("...")\`. For complex logic (multi-step, parsing,
loops, a library, DB writes), write the backend as a **script file** next to the page and
call it — the HTML/JSX is the frontend, the script is the backend handler.

- **Explicit interpreter**: \`cockpit.bash("node ./api.mjs")\` / \`python3 ./api.py\` /
  \`bash ./api.sh\` (avoids \`chmod +x\`); probe \`node\`/\`python3\` with \`command -v\` if unsure,
  and fall back to shell.
- **Pass args safely**: send structured input as **base64** (\`btoa(...)\` on the page,
  \`Buffer.from(arg,'base64')\` in the script) rather than string-building; use **parameterized**
  statements for DB writes.
- The script returns JSON on stdout; the frontend does \`JSON.parse\`. \`Write\` the script first, then call it.

## Fallback: single-file HTML (trivial / static one-off)

No state? Skip React and inline it. Same data/error handling as above.

Foreground (button fetches data):

\`\`\`html
<button id="load">Load</button>
<pre id="out"></pre>
<script>
  document.getElementById('load').onclick = async () => {
    try {
      const { stdout, stderr, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
      if (exitCode !== 0) { out.textContent = 'command failed: ' + stderr; return; }
      out.textContent = '⭐ ' + JSON.parse(stdout).stargazers_count;
    } catch (e) {
      out.textContent = 'exec error: ' + e.message;  // spawn / infra failure
    }
  };
</script>
\`\`\`

Background (live log):

\`\`\`html
<pre id="log"></pre>
<script>
  const box = document.getElementById('log');
  const h = cockpit.bash("tail -f ./build.log", {
    background: true,
    onOutput: c => { box.textContent += c; },
    onExit:   code => { box.textContent += '\\n[exit ' + code + ']'; },
    onError:  msg  => { box.textContent += '\\n[error ' + msg + ']'; },
  });
  // h.kill() when done
</script>
\`\`\`

## Where to store it

Put all of an app's files (\`index.html\` + \`app.jsx\` + \`api.mjs\` …) in a single
\`<name>/\` subdirectory. **You always pick \`<name>\`** from the request (lowercase
kebab-case, matching \`cockpit-name\`) — the user only describes the app, they don't
name it. Resolve the target directory as follows:

- The user gave a directory in the request → store under \`<the given directory>/<name>/\`.
- The user gave none → store under the **current chat working directory** (this session's cwd), i.e. \`<cwd>/<name>/\`.

Don't scatter files elsewhere or invent a directory like \`.cockpit-apps\`. This directory is what step 2 of the flow above tells the user; **after the user confirms**,
\`Write\` the files; the user clicks to preview and interact.`
