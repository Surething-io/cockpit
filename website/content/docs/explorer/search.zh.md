Cockpit 提供 4 种相互补充的代码搜索方式,大致按打字速度排序:

| 章节 | 何时用 |
|---|---|
| [快速打开文件](#快速打开文件) | 知道文件名。`Cmd+P` → 输入 → 回车。 |
| [LSP](#lsp) | 知道符号名 —— 跳转定义、查引用。 |
| [函数图](#函数图) | 想看某个函数周围谁调谁,可视化关系。 |
| [CodeGraph](#codegraph) | 想让 AI(或自己)查整张调用图 —— `/cg` 模式。 |

## 快速打开文件

大概知道要找的文件叫什么 —— 但不记得它在哪 —— 按 **`Cmd+P`**。Cockpit 顶部出现搜索栏；开始打字，匹配的文件立刻出现，按相关性 + 最近访问排序。

在任何面板都能用。不用先切到 Explorer。

### 匹配怎么算

打文件路径或名字的任意部分 —— 字母不必连续，但顺序要对。Cockpit 给每个结果打分：

- **连续字母匹配** 比分散的得分高。
- **匹配在文件名开头**或 `/` 后第一个字母比中间匹配排名靠前。
- **最近打开过的文件** 分数接近时浮上来。
- **大小写完全一致** 比大小写错的排前。

所以：

| 你打 | 大概率排首 |
|---|---|
| `useauth` | `src/hooks/useAuth.ts` |
| `botlist` | `app/components/BotList.tsx` |
| `set/index` | `src/settings/index.ts` |

### 搜什么

文件列表用 **ripgrep** 拉,默认**遵循你项目的 `.gitignore`** —— 所以 `node_modules/`、构建产物等通常不会出现。Cockpit 额外补一道:即使被 gitignore,`.env*` 文件也保留在列表里(方便开发时找配置)。

### 键盘

| 键 | 动作 |
|---|---|
| `↑` / `↓` | 移动选中 |
| `Enter` | 打开高亮的文件 |
| `Esc` | 关闭不打开 |

### 限制

- **没有** `:line:col` 跳转语法 —— `Cmd+P` 只打开文件。要跳到具体行，先打开文件，然后用 Vi `:42` 或文件内搜索（`Cmd+F`）。
- 没有内容搜索 —— `Cmd+P` 只搜文件名。整项目全文搜索用 Explorer 面板的 **Search** tab。


## LSP

在 Cockpit 代码查看器里打开 TypeScript、JavaScript 或 Python 文件，语言服务功能自动跟着来 —— 悬停看类型、`Cmd+点击` 跳转到定义。你不用配置什么：Cockpit 自带并管理 language server。

### 支持的语言

| 语言 | 文件 | 状态 |
|---|---|---|
| **TypeScript / JavaScript** | `.ts`、`.tsx`、`.js`、`.jsx`、`.mjs`、`.cjs` | 完整 LSP 支持 |
| **Python** | `.py`、`.pyi` | 完整 LSP 支持 |

Go 和 Rust 文件没有 LSP，但有 [Code Map](/zh/docs/explorer/search/#函数图) —— 基于调用图的导航，不需要 language server。

### 能用什么

| 功能 | 怎么做 |
|---|---|
| **类型信息** | 悬停符号 —— tooltip 显示类型签名和文档字符串。 |
| **跳转到定义** | `Cmd+点击`（Linux/Windows 上 `Ctrl+点击`）符号 → 跳到定义处。跨文件可用。 |
| **查找引用** | 悬停符号弹出 tooltip → 点 **Find references** 按钮；返回符号被使用的所有位置。 |
| **重命名** | 未实现。 |

### 你不用装任何东西

Cockpit 自带 language server 并按需启动：

- **TypeScript** —— 首次悬停或点击触发 `tsserver` 启动（第一次大约 2–3 秒，之后瞬间）。
- **Python** —— 首次悬停或点击触发 Pyright（第一次大约 1–2 秒）。

Cockpit 内部一个小注册表限制运行中的 server 数量（5 个），闲置 5 分钟后关闭，不会堆积僵尸进程。

### 常见问题

- **"跳转到定义"跳错地方** —— 动态类型的 JavaScript 或 Python 代码 language server 难以稳定解析。Cockpit 这边没法修；跟 VS Code 一样的行为。
- **第一次悬停没反应** —— 等一两秒让 language server 起来；后续同项目的悬停瞬间。
- **不支持我用的语言** —— Go、Rust 等用 [Code Map](/zh/docs/explorer/search/#函数图)。不需要 LSP。

### LSP 在哪些地方生效

| 界面 | LSP 激活 |
|---|---|
| 代码查看器 | ✅ |
| Code Map（BlockViewer） | ✅ |
| Diff 视图 | ✅ |
| Markdown 预览 | ❌（纯文本） |


## 函数图

**Code Map** 是 Cockpit 单文件的函数级架构视图。在 Code Map 模式打开一个源文件，看到文件里每个顶层函数：**调用者**在左、**代码**在中、**被调用者**在右 —— 都在同一行，不用面板间滚动。

它回答"我在读这个函数 —— 谁调用它，它又调用什么？"，不用离开你打开的文件。

### 打开 Code Map

在代码查看器（Explorer 里点开任意源文件后）顶部工具栏上,有个**视图切换按钮**;切到 Code Map 视图。文件树右键菜单里没有 Code Map 项 —— 必须先把文件打开。

### 你看到什么

每个顶层函数（或类方法、导出符号）Cockpit 排成三列：

```
| 调用者（上游）       |  函数签名 + 代码             | 被调用者（下游）     |
└─────────────────────┴──────────────────────────────┴──────────────────────┘
```

两侧的"pin"可点击：

| Pin 颜色 | 含义 |
|---|---|
| **蓝色** | 跨文件的调用 / 调用者 —— 点击跳到那个函数 |
| **棕色** | 同文件内的调用 |
| **灰色** | 外部 npm/pip 依赖 —— 可见但不可点击 |

点蓝色 pin Cockpit 跳到那个函数 —— Code Map 围绕它重绘。有前进 / 后退历史让你回溯。

### 支持什么

Code Map 用 tree-sitter 解析源文件，不需要 language server：

- **TypeScript / JavaScript** ✅
- **Python** ✅
- **Go** ✅
- **Rust** ✅

所以你写 Go 或 Rust —— Cockpit 还没完整 LSP 的语言 —— Code Map 是导航调用图的主要方式。

### Code Map vs LSP

|  | LSP | Code Map |
|---|---|---|
| 需要 language server | 是 | 否（tree-sitter） |
| 语言 | TS / JS / Python | TS / JS / Python / Go / Rust |
| 首次延迟 | 2–3s（server 启动） | 50–200ms（索引缓存） |
| 跨文件 | 有限 | 全项目 |
| 悬停类型 / 文档 | ✅ | ❌ |

实际两者都用 —— LSP 看"这个变量类型是什么"，Code Map 看"这个函数在代码库里处于什么位置"。

### Code Map 内搜索

在 Code Map 里 `Cmd+K` 打开一个小搜索框，让你在当前项目里跳到另一个文件或函数，不用离开 Code Map 模式。


## CodeGraph

**CodeGraph** 是驱动 [Code Map](/zh/docs/explorer/search/#函数图) 的同一份项目级索引，但开放给 AI 在 [`/cg`](/zh/docs/agent/skills/) 模式下查询。你不直接跟 CodeGraph 交互 —— 你问 AI 关于代码的问题，背后它走图而不是对每个文件暴力 grep。

### 能问什么样的问题

`/cg` 模式的 AI 能回答：

- "`Parser` 定义在哪？" —— 项目级符号搜索。
- "谁调用 `Parser.parse()`？" —— 上游调用者。
- "`parse()` 调用了什么？" —— 下游被调用者。
- "改 `debounce()` 会影响什么？" —— 影响分析（在调用图上 BFS）。
- "`src/parser.ts` 里有什么？" —— 文件概览。
- "哪些文件经常跟 `parser.ts` 一起改？" —— 来自 git log 的共同编辑历史。

AI 替问题挑对的查询，返回带文件路径和行号的聚焦回答，不是甩一堆 grep 输出。

### 为什么这样更快

对"X 在哪被调用？"这种问题，基于 grep 的探索要：

1. 读项目里的每个源文件。
2. 按字符串匹配过滤。
3. AI 还得猜哪些匹配是真调用、哪些是字符串提及。

CodeGraph 在索引时一次性建好答案（它真的解析调用图），之后任何查询都在几十毫秒内返回。AI 回复更快，也更聚焦真实调用点，不会被注释和字符串字面量带偏。

### 支持的语言

CodeGraph 用 tree-sitter 解析，跟 Code Map 一样：

- TypeScript / JavaScript
- Python
- Go
- Rust

### 构建时间和新鲜度

索引在被首次查询时构建 —— 一般项目不到 1 秒，超大项目几秒（上限 ~8000 文件）。之后随你编辑文件增量更新：改一个文件只重新解析这个文件，不重做整个项目。

不用手动触发构建。新项目的第一次 `/cg` 查询付索引成本；之后都是瞬间。

### 共同编辑历史

"经常一起改的文件"查询读你过去 ~100 个提交的 `git log`，跳过动了大量文件的重构提交。所以 AI 告诉你"你要改 `parser.ts`，大概率也要看 `lexer.ts`"时，是基于你团队真实把这俩文件一起改的历史。

### 用户能直接看吗

CodeGraph 本身是 AI 专用 —— 数据结构在 UI 里不可浏览。你自己探索同样信息用：

- [Code Map](/zh/docs/explorer/search/#函数图) —— 每次看一个函数的可视化调用图。
- [LSP](/zh/docs/explorer/search/#lsp) —— 代码查看器里悬停和跳转定义。

