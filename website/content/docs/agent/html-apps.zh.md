普通的 HTML 预览是**纯静态**的 —— 页面想拉真实数据,会被同源沙箱用 CORS 拦住。**HTML 小应用**把这层墙拆了:用 `/html` 让 AI 生成一个小应用,预览时注入一个 `window.cockpit` SDK —— **本质就是把 Bash 工具暴露给页面**。于是按钮能 `curl` 拉数据、读写文件、跑脚本,一份静态页就成了有后端能力的小工具。

它是 [Skills](/zh/docs/agent/skills/) `/` 菜单里的内置命令,和 `/qa`、`/fx` 同路。生成的页面能在**聊天预览弹窗**、**Explorer 文件浏览器**、或 [Console 浏览器气泡](/zh/docs/console/browser/)里运行,还能收藏进 **HTML 面板**随时再开。

## 用 `/html` 生成一个

在 Agent 聊天框打 `/html`,后面写你想要的页面:

```text
/html 帮我做一个 GitHub 仓库 star 看板,输入仓库名就显示 star、fork、最近提交
```

剩下交给 AI —— 你只描述**想要什么**,不用管怎么搭。默认它会:

- 生成一个 **React 页面**(零构建,依赖由 Cockpit 本地托管,离线可用);
- **自动套用 Cockpit 主题**,带亮/暗,右上角有切换按钮;
- 通过 `cockpit.bash` 跑命令取/改数据(**不走 `fetch` 外部 URL** —— 会被 CORS 拦)。

> 这些规则都写在 `/html` 的内置 prompt 里,平时你不用关心。想手改页面时,看下面的 SDK 速览。

## `cockpit` SDK 速览

页面加载时,这个全局对象已就绪,**无需引入任何库**:

| API | 作用 |
|---|---|
| `cockpit.cwd` | 当前文件所在目录;相对路径命令默认在这里执行 |
| `cockpit.bash(command, opts?)` | 跑一条 bash 命令,对齐 Bash 工具 |
| `cockpit.toggleTheme()` | 切换深/浅(右上角也有按钮) |

`cockpit.bash` 前台一次性拿输出、后台流式:

```js
// 前台：短命令，await 拿 { stdout, stderr, exitCode }
const { stdout, exitCode } = await cockpit.bash("curl -s https://api.github.com/repos/Surething-io/cockpit");
if (exitCode !== 0) { /* 命令跑了但失败，看 stderr */ }
const repo = JSON.parse(stdout);

// 后台：长/实时命令，opts.background + 回调，返回 { kill() }
cockpit.bash("tail -f ./build.log", { background: true, onOutput: c => { /* … */ } });
```

复杂后端(多步、写库)让 AI 写成同目录**脚本文件**,用 `cockpit.bash("node ./api.js")` 调它 —— 像 CGI 一样,页面管展示、脚本当后端。

> **⚠️ 预览即运行,请注意风险。** `cockpit.bash` 是一条真实的命令执行通道(等同于在你机器上跑 shell)。在 Cockpit 里预览一个本地 `.html`,会**以你的权限执行它的脚本**,风险和你亲手运行这个文件完全一样。所以**不信任的 `.html` 就不要去预览、也不要收藏** —— 来路不明的第三方页面能做你在终端里能做的任何事。(它仍服从 Cockpit 启动时的 token 门:没设 `--token` 时本机开放,设了则校验。)

## 打开与收藏

生成后,你有几个入口:

- **聊天预览弹窗**:AI 写完点开即预览。右上角两个按钮 —— **收藏进 HTML 面板**(书签图标)和**在 Console 气泡打开**(外链图标)。
- **Explorer 文件浏览器**:选中任意 `.html` 先看**源码**;点**预览**才渲染并运行 —— HTML 不会自动预览,这一下点击就是授予它 SDK。工具栏也有这两个按钮。
- **Console 浏览器气泡**:让小应用在会话里常驻运行的地方。现在三种预览(聊天弹窗、Explorer、气泡)都带 SDK,气泡只是切走再回来还留着。

### HTML 面板

Console 输入栏最左侧的 **窗口图标** 按钮打开面板:一个卡片网格,列出你收藏的小应用(卡片的名字 / 说明 / 图标来自页面 `<head>` 里的 meta)。每张卡片能**预览**、**删除**、**复制路径**;点卡片就在 Console 气泡里打开。无效(文件被删 / 移走)的会灰显并标 `Invalid`。

面板只记**绝对路径**,登记表在 `~/.cockpit/html.json`(机制和 `skills.json` 一样)。HTML 文件本身留在你项目里 —— 面板只是个书签夹。

### 用 `/名字` 快速打开

在 Console 输入栏打 `/`,已登记的小应用会**排在自定义命令前面**(带蓝色 `HTML` 标签),选中或回车就在气泡里打开。这个短名就是页面 meta 里的 `cockpit-name`。它不拦真实命令 —— `/usr/bin/x` 仍按路径处理。

## 下一步

- [Skills](/zh/docs/agent/skills/) —— `/html` 所在的 `/` 命令菜单
- [工作流](/zh/docs/agent/workflows/) —— 把多个命令串成有序步骤
- [浏览器气泡](/zh/docs/console/browser/) —— HTML 小应用运行的地方
