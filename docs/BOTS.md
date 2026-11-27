# Bots：普通目录 + 独立子会话

状态：已实施（2026-09-18）。

一个 Bot 就是一个带 `BOT.md` 的普通目录，注册后用 `@name` 寻址，每次调用交给一个独立子会话执行。
Cockpit 只做三件事：认名字（`bot.json`）、改写消息文本（标签 + 引用清单）、提供派发与状态接口。
它不读、不写、也不锁 Bot 目录。

## 1. 结论

Bot 与 skill 采用同一套轻量模式：

```text
/bot             → 创建：在指定目录生成 Bot 文件夹（BOT.md + 上下文文件）
@name 装上 <path> → 装技能：往该 Bot 的 BOT.md Skills 表加一行（不复制文件、不改 skills.json）
@name 复盘一下    → 通读该 Bot，保存待确认清单，按用户点名执行
添加 Bot         → 注册到 $COCKPIT_HOME/bot.json（Bots 面板粘贴路径，或文件浏览器 BOT.md 按钮）
@name 行首指令   → 渲染为 subagent 标签；派发方读 bot-run 写 brief 并派发，执行方读 bot-turn + BOT.md
                   默认只读；用户明确要求时才加写锁修改
```

Cockpit 不介入 Bot 目录的读写。Bot 目录就是普通文件夹，用户可以任意修改。

## 1.1 显式更新与写锁

更新与加锁完全是 `bot-turn/writing.md` 中的约定，由 subagent 遵守，Cockpit 不参与（Cockpit 无法区分一次 subagent 调用是读还是写）。

- **何时写**：只有任务明确要求 记住 / 更新 / 纠正 / 删除 时才修改 Bot 文件；否则只读，在汇报末尾列出 "Could be recorded" 供用户确认。读不加锁，多个会话并行读互不阻塞。
- **写锁**：`mkdir <bot>/.locks/write` 是原子操作，只有一个会话能成功。`owner` 文件记四行——`run`（`$COCKPIT_RUN_ID`）、`cwd`（**该会话自己的工作目录**，取 `$COCKPIT_CWD`，见 §2.1；不是 `pwd`，也不要改写成 Bot 目录）、`since`、`task`。拿不到锁时每 10 秒重试约 2 分钟。
- **仍拿不到时按 `owner` 判定，绝不按时间抢占**：`run` 等于自己 → 是本会话上一轮崩溃留下的（会话跨轮次 run id 稳定），可安全清理；否则拿 `cwd` + `run` 去问 `GET /api/sessions/status`——`running` 表示有人正在干活，**不许清**，其他状态或 404 表示那个 run 已经结束。（写的是会话自己的 cwd 而不是 Bot 目录，是因为 `status` 按 `cwd + sessionId` 定位 transcript；复盘/装技能/导出这三种场景下会话本来就开在 Bot 目录里，两者恰好相同，这不影响规则——照抄 `$COCKPIT_CWD` 即可。写错一个字符，查出来就是"没有这个会话"，而它会被读成"锁是死的"。）即便判定为死锁，清理也是用户的决定，模型只报告。按时间抢占会让两个会话同时写，而且旧持锁者释放时还会删掉新持锁者的锁。
- `mkdir` 与写 `owner` 是两步，所以"锁在但 `owner` 不在"是正常瞬时态，不能当成无主锁。拿到锁后重新读取目标文件（锁前读到的可能已过期），完成或失败都 `rm -rf` 释放。
- `.reviews/<日期>-<时间>.md` 是唯一例外：它是工作产物不是记忆，文件名唯一因而不会互相覆盖，不取写锁。
- **残余风险**：锁靠模型遵守约定，Cockpit 不强制。由于写入是显式且低频的，且 Claude Code 的 Edit/Write 会拒绝"读取后被改动"的文件、Codex 的 apply_patch 上下文不匹配会失败，静默覆盖的概率很低；锁主要避免两次更新写入互相矛盾的内容。

## 2. 三种指令

| 前缀 | 候选来源 | 执行位置 | 引用清单 |
| --- | --- | --- | --- |
| `/skill` | builtin `skills/` + `skills.json` | 主会话 | SKILL.md |
| `/@skill` | 同上 | subagent | SKILL.md |
| `@bot` | `bot.json` 中有效的 Bot | 按 `bot-run` 契约派发独立子会话 | BOT.md |
| `@<会话标题>` | 会话 Bot：改名框里勾了「可被 @ 调用」的会话，登记在 `session-bots.json`，与 Bot 同列（`@` 补全、Bots 面板）；`@` 后首词不是 Bot 时才查 | 按 `session-run` 契约发进**那个已有会话**（同手动发送：忙则并入当前运行），**默认等结果带回**，`--no-wait` 才只发不等（与 `/dl` 相反：`@` 会话多是问它事） | `session-run` + 目标的 cwd / sessionId |

`@<会话标题>` 的匹配规则在 `shared/sessionMention.ts`：名字是会话**当前**标题（自定义或默认皆可），标题须合规（单行、不含 `@`，规则见 `shared/sessionTitle.titleNameProblem`；自定义标题保存时即按此校验，对话框的 ✨ 按钮用会话自己的引擎生成合规标题）；取行首能对上的**最长**标题（不分大小写，标题后须是空白或行尾），其余是任务；两个会话 Bot 同名时不发、在消息里列出候选。命中行渲染为 `[session·@标题] <正文>`，派发走 `POST /api/sessions/delegate` 带 `sessionId`——引擎、模型都沿用目标会话自己的，消息首行标明来源会话。

解析在 `packages/feature/agent/src/server/lib/slashCommands.ts::resolveCommandPrompt` 完成，与 skill 共用同一套"就地标注"规则：

- 任意行首均可出现，一条消息可以有多个 `@bot`，并可与 `/`、`/@` 混用；
- 正文 = 同行文本 + 紧随其下的连续非空行，空行是硬边界；
- `@bot` 行渲染为 `[subagent·@name] <正文>`；消息末尾的引用清单按"拿它做什么"分成两块：**要读的 skill 文件**（`bot-run`）在前，**要原样转交、自己不许打开的文件**（`bot-turn` + 各 `BOT.md`）在后。两块合用一个"请先读取"的标题曾直接造成事故：派发方照做读了 `BOT.md`，又在下一行看到 `bot-run` 说不要读，自己报告"这两条互相矛盾"；
- **该 Bot 的目录正好是本会话的 cwd 时，这一行改渲染成 `[main·@name]`，引用清单也跟着换边**：`bot-turn` 和那个 `BOT.md` 落到"要读的"一块，`bot-run` 整个不出现（没有派发可言）。判定逐行独立，见 §2.3；
- `/@` 在正则交替中先于 `/` 匹配；
- 未注册的 `@name`（包括旧写法 `@cr`）保持普通文本，不提示、不改写；
- 执行顺序与并行由模型读完消息后自行决定，与 `/@skill` 一致；
- **`[subagent·@name]` 是给模型的提示，不是 Cockpit 强制的执行位置**。和 `/@skill` 一样，Cockpit 既不断言也不记录真正的执行位置。缩小这个缺口的是 `bot-run`：只要消息里出现任一 `@bot`，引用清单就带上这个**隐藏** builtin skill（`hidden: true`，不进 `/` 补全、不进 `/api/commands`），它给出完整的派发流程——写自包含 brief → `POST /api/sessions/delegate` → 轮询 `/api/sessions/status` → 汇报结论 + 会话链接。因此按 Bot 执行契约，标准路径是**独立子会话**（有自己的 transcript、可续问），而不是主会话内联；代价是这仍靠模型遵守 skill，没有在 dispatch 层硬强制。若某天需要硬强制，再上 `PreToolUse` hook 或 dispatch 层拦截。唯一的例外在 §2.3：会话本身就开在这个 Bot 的目录上时，子会话唯一能提供的东西——Bot 的那堆文件——主会话已经有了，于是标签直接渲染成 `[main·@name]`，连派发的机会都不给。

- **两个隐藏 builtin，按读者划分，这是本设计的主承重墙。** 出现 `@bot` 时清单挂上两个 `hidden: true` 的 skill（不进 `/` 补全、不进 `/api/commands`）：

  | | 读者 | 内容 | 失败时 |
  | --- | --- | --- | --- |
  | `bot-run` | 派发方（主会话） | 写 brief → delegate → 汇报（常驻），另按需加载 `wait.md`（轮询循环 / 预算 / 状态语义）、`followup.md`（续会话） | 写不出文件时**内联**正文，否则 `@bot` 变成没有派发方法的空标签 |
  | `bot-turn` | 执行方（子会话） | 读取规则 + 汇报规则（常驻），另按需加载 `writing.md`（条目格式 / 写入门槛 / 写锁）、`review.md`（复盘）、`attach.md`（装 skill）、`export.md`（导出模版） | **不内联** —— 它是写给 child 的，内联等于把 Bot 的全部操作手册塞进唯一不该拿到它的会话 |

  判据是**加载时机**：写锁在用户说"记一下"的那一刻执行，那一刻 `/bot` 没被加载（它是斜杠命令）、`bot-run` 也不在（那是派发方的文件），只有 `BOT.md` 和 child 手上的东西在。所以写锁既不能放 `/bot` 也不能放 `bot-run`，必须有第三份、且由 `bot-run` 指示 child 去读。

- **命令按"Bot 存不存在"划界，不按"功能"划界。** `/bot` 只创建——那时还没有 `@name` 可用，斜杠是唯一的表达。一切**对已存在的 Bot** 做的事都寻址到 Bot 本身：`@name <任务>`、`@name 复盘一下`、`@name 装上 <SKILL.md 路径>`，说明书随之落在 `bot-turn`（干活的是子会话，它才需要知道怎么复盘、怎么加锁写表）。`bot-run` 全程不需要知道"复盘"是什么，它是传送带。收益不止自然：复盘与装 skill 都要改 Bot 文件，而只有子会话手上有写锁；先前 `/bot review` 在主会话里执行，`## Updating` 又刚把写锁搬走，那条指针是断的。

- **两个隐藏 skill 都渐进式加载。** 一个 builtin skill 目录下除 `SKILL.md` 外的 `*.md` 会被一并复制到 `~/.cockpit/skills/<cmd>/` 并做同样的占位符替换（它们不是命令：注册表只认"含 SKILL.md 的目录"）。`bot-turn` 因此常驻 ~80 行、其余 240 行按需打开——契约本身就规定"默认只读"，所以绝大多数轮次根本用不到写锁与条目格式。代价是模型可能不去读就动手，所以 `SKILL.md` 里把它写成硬停止而不是建议：**要改文件而本轮没打开过 `writing.md`，就停下来先打开**；再配合每轮末尾"列出读了哪些、改了哪些"，违例在那张清单里看得见。

  `bot-run` 后来按同一判据拆了一次：13.7KB → 9.2KB，轮询（`wait.md`）与续会话（`followup.md`）移出常驻部分。它和 `bot-turn` 的形状并不一样——六节里有四节在关键路径上，所以**能拆的不是"大的"而是"有明确触发条件的"**。两条界线值得记下来：`[main·@name]` 那节只有 978 字节却必须留在常驻部分（模型看不到它就会把本地那一行照样派发出去，而且没有任何报错）；轮询那节最大却可以移走，因为 `bot-turn` 早有先例——**最危险的写锁本来就在 `writing.md` 里**，安全感来自响亮的触发条件（"POST 已返回而本轮没打开过 `wait.md`，停下先打开"），不是来自内联。

- **等待不设固定上限，优先后台执行。** 一次 Bot 轮次经常跑赢单次 bash 调用的工具超时 —— 两次实测的工作区 code review 分别是 7 分 18 秒和 **11 分 08 秒**，后者直接越过了曾经写死的 10 分钟上限。`bot-run` 因此首选 `run_in_background` 之类的后台执行（超时约束整个消失、完成时被通知、期间主会话可以干别的，这是模型自己在真实运行里找到的更优解）；不支持时退化为分段前台轮询：按 `BUDGET` 秒跑一段、打印状态、退出，还在 `running` 的带着剩下的 sessionId 再跑一次。原来那个 `seq 1 46` 循环还有个更硬的错：光 sleep 就是 630s，**超过单次调用 600s 的上限**，根本跑不到最后一行。跑过约半小时就停止静默等待、把链接交给用户。

- **复盘的多轮交互靠文件接力。** 子会话跑完即结束，而复盘是"出清单 → 用户点行号 → 执行"。清单落到唯一命名的 `<bot>/.reviews/<YYYY-MM-DD>-<HHMMSS>.md`（工作产物，永不作为事实读回），于是两条路都通：在该子会话里直接回行号，或在任何会话说 `@name apply .reviews/<review-file>.md rows 1 3`，新会话读文件即可恢复全部上下文。这个报告是唯一不需记忆写锁的 Bot 目录写入；它不改长期上下文，唯一文件名避免并发覆盖。副产品是下次复盘知道上次查过什么。

- **`BOT.md` 只写"这个 Bot 是谁"**：角色、读哪些文件、有哪些 skill、新条目写到哪。通用机制一律在 `bot-turn`。理由是可回滚性：写进 `BOT.md` 的东西会随每个 Bot 复制一份、冻在用户磁盘上；写进 `bot-turn` 的东西改一次、所有已存在的 Bot 立刻生效。判断标准——**"这句话放到另一个 Bot 的 BOT.md 里会不会是错的？"** 不会，就说明它属于 `bot-turn`。存量 Bot 的迁移出口是复盘的「Frozen machinery」检查。

示例：

```text
@product 总结本周路线图变化

@finance 对照核对 Q3 预算
/qa
```

→

```text
[subagent·@product] 总结本周路线图变化

[subagent·@finance] 对照核对 Q3 预算
[main·qa]

请先读取以下 skill 文件，再据此执行：
- qa：/Users/me/.cockpit/skills/qa/SKILL.md
- bot-run：/Users/me/.cockpit/skills/bot-run/SKILL.md

以下文件交给你派发的子会话去读，你只转交路径，不要自己打开：
- bot-turn：/Users/me/.cockpit/skills/bot-turn/SKILL.md
- @product：/Users/me/.cockpit/bots/product/BOT.md
- @finance：/Users/me/.cockpit/bots/finance/BOT.md
```

### 2.1 子会话的 cwd

`bot-run` 决定派出去的子会话开在哪，两种答案：

| `@name` 这一行是 | cwd |
| --- | --- |
| 普通工作 | 派发方自己的 `pwd`，**原样照抄** |
| 导出 / 复盘 / 装上 | 该 Bot 自己的目录（消息末尾那个 BOT.md 路径取 `dirname`） |

- 普通工作在项目里进行，Bot 用绝对路径够到自己的文件即可；这三个维护动作的**对象就是 Bot 目录**——`.locks/` 在那里、复盘的 `.reviews/` 写在那里、Bot 目录若是 git 仓库也只有在那里才能 `git`。取 `dirname` 不算"打开 BOT.md"，不读正文的规矩照旧。
- **普通工作那一格不是让模型填的值，是一个变量**：`${COCKPIT_CWD:-$PWD}` 原样写进 delegate 的 JSON（heredoc 未加引号，shell 自己展开），模型全程不需要知道它等于什么。
- `COCKPIT_CWD` 由各引擎在 spawn 时注入（`claude.ts` / `codex.ts` / `builtinAgent/tools.ts`，走 `sanitizedSpawnEnv`，与 `COCKPIT_RUN_ID` 同一条路），值是该会话启动时的 cwd。
- **它和 `pwd` 不是一回事**：会话中途 `cd` 过、或 Claude Code 在命令之间重置了 shell cwd，`pwd` 就变了而它不会。凡是"用来标识这个会话"的地方都必须用它——`POST /api/sessions/delegate`、写锁 owner 文件、以及两处按 `cwd + sessionId` 查的 `GET /api/sessions/status`。
- 之所以要走环境变量而不是把 cwd 替换进 skill 文件：builtin skill 解析后写在 `~/.cockpit/skills/<cmd>/SKILL.md`，**整个 COCKPIT_HOME 共用一份且每次派发都重写**。派发方在 T 时刻读 `bot-run`、子会话在 T+几分钟才读 `bot-turn`，中间任何一次别的派发都会把文件改掉——per-dispatch 的值放进去不只是竞态，是系统性过期。`{{BASE_URL}}`、`{{COCKPIT_DIR}}` 能那样做，只因为它们对这台机器是常量。
- 起因：cwd 是派发唯一需要、而模型手上又没有的事实，于是它去**推断**——实测踩过一次，会话开在某个仓库的子目录里，派发方看到仓库根有 `.git` 和 CLAUDE.md 就一路往上推到了根目录，子会话因此开在用户工作目录的上一级，transcript 落到了另一个项目下（`~/.claude/projects/` 按 cwd 编码分目录）。
- **Cockpit 只提供值，不替模型选**：它看不出这一行是普通工作还是导出/复盘/装上（那三种要用 Bot 目录）。选哪个仍归 `bot-run` 的表。

### 2.2 续会话

派发出去的子会话不是一次性的：`POST /api/chat`（claude；其它引擎为 `/api/chat/<engine>`）带上 `{ cwd, sessionId, prompt }` 就是往那个会话追发一条消息，返回 `{ runKey, sessionId }`，之后照 `bot-run/wait.md` 同样轮询 `/api/sessions/status`。会话正在跑时返回 `409 session is already running`（`orchestrator.ts` 的单活跃 run 守卫），等它结束再发。

`bot-run/followup.md` 专门写了这条，因为**缺了它的代价不显眼**：实测有一次派发方判定"Cockpit 没有续会话的接口"，于是重新 delegate 了一个新会话，把上一轮的结论浓缩成一段 brief 带过去——新会话从零开始重读 Bot 的文件，上一轮查过什么、排除过什么、用户已经回答过什么全部丢失，同一件事付了两次钱。

### 2.3 就在 Bot 目录里：不派发

会话的 cwd 正好是某个 Bot 的目录时，`@name` 这一行在本会话里直接执行：读 `bot-turn` 再读 `BOT.md`，自己干，不写 brief、不 delegate、不轮询。理由很直白——派发存在的意义是给 Bot 一个"手上就是它那堆文件"的会话，而这个会话已经是了；再派一个只买到冷启动和第二条 transcript。

- **判定在服务端**，`slashCommands.ts` 的 `isLocalBotDir(cwd, manifestPath)`。cwd 由 `dispatchChat` 从 `body.cwd` 传进 `resolveCommandPrompt`（就是各引擎导出成 `COCKPIT_CWD` 的那个值）；缺失或非绝对路径 → 一律派发，等于没有这条规则之前的行为。
- **严格相等，不是包含关系**：去掉尾部斜杠后两端都过 `realpathOr` 再 `===`。漏判的代价是零（那一行照常派发），而包含关系会让"仓库根目录下有 `bots/`"的会话把项目里每一行 `@bot` 都吞掉。
- **两端都要归一化，因为来源不同**：项目 cwd 是客户端原样发来的（服务端全程不碰），用户注册的 Bot 在 add 时做过 `realpathSync.native`，内置 Bot 则是 `COCKPIT_DIR` 字符串拼接。裸 `===` 会在尾斜杠、符号链接（`/tmp` vs `/private/tmp`）、大小写上**静默**失配——`@bot` 照样派发，唯一症状是"这功能好像没生效"。`realpathOr` 从 `builtinBots` 导出复用，必须和 `botRegistryLive` 用同一个实现（JS 与 native 的 realpath 在 Windows 8.3 短名上不一致，曾让同一个目录被注册成两个 Bot）。
- **逐行独立判定**，所以一条消息可以一半本地、一半派发。这种消息里 `bot-turn` 会**同时出现在两块**（本会话读它、也要把同一个路径原样转交），所以去重键是 `kind:name` 而不是 `name`，而"转交"那块的标题也换了措辞——不能再说"不要自己打开"，上一块刚让你打开它。
- **顺序是硬规矩**：先把所有要派发的 POST 出去，再干本地那份，最后轮询。本地执行是串行的，模型的自然倾向（先干手边的）会让子会话白等一轮，所以这条写死在 `bot-run` 里。
- 代价说清楚：本地那一轮**没有 session link 可汇报**（它就在当前 transcript 里），按停止键这次**真能停**（派发出去的停不掉），而 Bot 目录的子目录（`memory/` 等）不生效且没有提示。

### 2.4 子会话的引擎

`engine` 不指定时，子会话**继承发起方会话正在用的引擎**（`claude` 只是最后的回落值）。在 GLM 或 Codex 会话里说 `@bot`，意思是"再来一个这样的"，不是"顺便换成 claude"。

- 引擎读不出请求体：一轮聊天用哪个引擎是**路由**决定的（`/api/chat` vs `/api/chat/<engine>`），所以唯一的记录是发起方自己那条 run registry 条目。为此 `RunState` 加了 `engine`，由 `orchestrator` 在 `startRun` 时用 `spec.name` 填。
- 取值走 `getRunInfo(runId)?.engine`，**不能复用 `resolveParent`**：后者要求 `sessionId` 已揭晓，而新会话的第一轮还没有——继承会恰好在"新开会话、第一句就 `@bot`"这个最常见场景里静默退回 claude。
- 回落 claude 的三种情况：没有 `x-cockpit-run-id` 头、run 已过宽限期被 evict、父引擎不在 `DELEGATION_ENGINES`（如内置 agent 引擎）。但**请求体里显式写了非法 engine 仍然报 400**——那是调用方拼错了，静默改跑别的比报错更糟。
- 只继承引擎，**不继承 model**：模型是"我这一轮要用它"，而不是"我派出去的每个 Bot 都用它"，跟着继承等于把单价乘以并发子会话数。
- 规则挂在端点上，所以 `/dl` 与 `@bot` 一视同仁——端点分不出、也不该靠标题前缀去猜谁是 Bot。

## 3. BOT.md

与 SKILL.md 相同，frontmatter 只有两个字段：

```markdown
---
name: product
description: "产品上下文与决策记录"
---
```

- `name` 缺省时取目录名（小写）；必须匹配 `^[a-z0-9][a-z0-9-]{0,63}$`，否则该 Bot 在列表中显示为无效且不参与解析；
- `description` 可选，用于 `@` 补全；
- 其他 frontmatter 字段忽略；
- 正文只写这个 Bot 自己的部分：`## Before working`（先读哪些文件 + 只对本 Bot 成立的规则）、`## Skills`（表格）、`## Updating`（各类信息写到哪个文件）。通用机制（读取规则、条目格式、写入门槛、写锁、汇报）在 `bot-turn`，复盘流程在 `bot-turn/review.md`——都不写进 `BOT.md`，这样改进能随 Cockpit 升级到所有已存在的 Bot。Cockpit 不解析正文。

`/bot` 生成的推荐结构（注册时不校验）：

```text
<name>/
├── BOT.md
├── identity/        persona.md, principles.md
├── relationships/   user.md
├── memory/          facts.md, procedures.md
├── projects/        <project-name>/CONTEXT.md（项目名 kebab-case，默认取项目根目录名）
├── skills/          按需创建：该 Bot 自己长出来的 SKILL.md
├── commitments/     active.md
├── evidence/        refs.md
└── secrets/         仅当凭证确属该 Bot 自己时才有；永不读取、永不打印
```

**凭证归工具，不归 Bot**：skill 的 `.env` 文件留在该 skill 目录下，多个 Bot 装同一个 skill 时共用一份，不复制密钥。只有"这个 Bot 用自己的账号"这种情况才放 `<bot>/secrets/`。两种情况下，若目录是 git 仓库都应加入 `.gitignore`。

读取约束：subagent 永不打开 `.env*`、`secrets/` 或任何凭证文件——读上下文时不开，复盘通读目录时也跳过不开。任务确实需要时，把路径交给消费它的工具，不把内容读进回答、报告或记忆文件。

### 3.1 条目元信息

每条记录是一个 `## 标题` 小节加一行元信息注释，供后续复盘判断新鲜度与来源：

```markdown
## <标题>
<!-- confirmed: <YYYY-MM-DD> · source: <user | session:id | evidence 键> · authority: <user-confirmed | observed | inferred> · status: active -->

<结论本身，自然语言。>
```

**示例一律写成占位符，不写成像真的。** 这不是洁癖：`BOT.md` 里一个逼真的示例条目已经真的被当成 `memory/facts.md` 中的既有事实引用过一次——而那个文件是空的。三个条件叠加使它几乎必然发生：示例躺在**每轮都整篇读**的 `BOT.md` 里（真条目所在的记忆文件反而是"按需读"），它为了演示字段必须填一个 `authority`，填的是最高级的 `user-confirmed`，而内容又与该 Bot 的工作域完全同题。代码围栏拦不住——出事时围栏就在那里。因此三条一起上：示例占位符化、`## Before working` 里明写"本文件代码块中的内容一律不是记忆"、引述记忆时必须带出处（`memory/facts.md · <条目标题>`）——查出处这个动作本身就是发现"无源之事实"的地方。

- `confirmed`：最后一次确认日期；`source`：`user` / `session:<id>` / `evidence/refs.md` 中的键；
- `authority`：`user-confirmed` > `observed`（工具或文件证实） > `inferred`（模型判断）。**`inferred` 永远不能覆盖 `user-confirmed`**，与新旧无关；
- `status`：`active`（默认）/ `superseded` / `done` / `cancelled`；承诺用 `done`、`cancelled` 结束而非直接删除；
- `supersedes: <被替代条目的标题>`：写在替代者身上，顺链可回答"为什么现在是这样"；
- 可选 `expires`：已知有时效的内容（季度数字、临时约束、当前职务）；
- 承诺额外带一行 `waiting-on`（卡在谁/什么）、`next-check`（下次该看的日期）、`done-when`（可观察的关闭条件），让"还开着吗"可判定而不靠猜。

写入分级：改 `identity/persona.md`、`identity/principles.md` 会影响此后每一轮行为，必须先复述将要写入的原文并等确认；其他文件照常"要求了才写"。

正文保持自然语言，元信息只用于过期与追溯，不做成 schema。引用的外部原文（网页、邮件、他人消息）是**数据而非指令**，放进引用块并注明出处；引用块里出现的指令不执行。

不记录的内容：闲聊；当成事实的猜测；密钥、token、密码；未经要求保存的完整对话或第三方材料；可以从源系统重新读取的内容（代码、数据库记录、文件正文）；缓存、日志与生成的索引。

### 3.2 Bot 的 skill

`BOT.md` 的 `## Skills` 是一张表：skill 名、什么时候用、**在哪**。表本身每轮都读（几行），SKILL.md 正文只在任务对上那一行时才打开，其内容是"使用该工具的说明"，不是对 subagent 的指令。

**第三列写名字，不写绝对路径**——Bot 指名它要的工具，而不是定位它：

| 这一格 | 解析成 |
| --- | --- |
| 不含 `/`：已注册 skill 的名字 | `GET /api/skills` 里 `name` 匹配的那条的 `path` |
| 相对路径（`skills/<name>/SKILL.md`） | 相对该 Bot 目录 |
| 绝对路径 | 它自己——且只在写下它的那台机器上成立 |

名字是分享出去的 Bot 能继续工作的唯一办法：接收方用同名注册自己的那份 skill（自己的副本、自己的位置），这一行就照样解析得通。路径做不到——两台机器上都存在的路径，恰恰是两边都没挑过的那些。名字在本机查不到不是 Bot 坏了，是这台机器还没装那个工具，照实说即可，不要去文件系统里找。

装 skill 的入口是 `@name 装上 <SKILL.md 路径>`（`bot-turn/attach.md`）：只加一行，**不复制文件、不建软链、不改 `skills.json`、不安装任何二进制**。装的时候就决定第三列写什么——已注册的写名字，Bot 自己的写相对路径，两者都不是才写绝对路径并明说"只在这台机器上成立"。另外两件容易混淆的事要明确区分并停下来确认：注册全局 `/name` 命令属于 skills 注册表，安装 CLI 属于装软件。

Bot 自己长出来的 skill 放 `<bot>/skills/<name>/SKILL.md`，在同一张表里登记。与 `memory/procedures.md` 的界线：procedures 是"当时怎么做成的"叙述，skill 是可照着一步步执行的操作手册。

### 3.3 复盘

入口是 `@name 复盘一下`（`bot-turn/review.md`），由用户显式触发，是唯一会通读整个 Bot 目录的场景：

- 十一类检查：过期（`expires` 已过或时效性内容 `confirmed` 过旧）、矛盾、悬空承诺（`next-check` 已过、`done-when` 已满足，或既无进展也无日期）、来源缺失或断链、重复、仍是模板的空文件、**依据已被推翻**（active 结论所依赖的事实已 superseded / 过期 / 存疑，靠通读语义判断，不设 `derived-from` 字段，写入端零负担）、**规模超标**（单个记忆文件约 200 行以上，或"always 读"的内容一轮装不下）、**技能失效**（Skills 表里的文件已不存在）、**机制冻结**（`BOT.md` 里重复了已迁到 `bot-turn` 的内容——写锁、条目格式、不记录清单、读取或汇报规则；这份副本再也改不动，建议换成只留本 Bot 特有的部分）、**假条目**（`BOT.md` 的示例块里写着逼真的 `## 标题` + 元信息，会被当成事实读回，建议改成占位符）；

  「机制冻结」是存量 Bot 的迁移出口：`bot-turn` 拆出来之前创建的 Bot，正文里带着一整套通用机制的副本，只有复盘会通读到它们。
- 规模超标的处理是**分层装载的最小版本**，由复盘在到点时推动落地（不提前做，也不做成常驻机制）：按主题拆分文件、每个目录加 `INDEX.md`（标题 + 一句话 + 文件名）、改写该 Bot 的 `## Before working` 为"先读索引、按需读条目"，承诺与当前项目仍为 always；不做预算计算，也不引入检索层；
- 矛盾先分类再处理：**时间性**（新的 supersede 旧的）、**作用域**（拆成两条，不算矛盾）、**权威**（`inferred` 让位于 `user-confirmed`）、**规范性**（两条规则互斥，停下来问用户）、**事实性**（可信来源不一致，并存标记存疑）。偏好、承诺和用户确认的事实一律禁止"最后写入获胜"；
- 输出编号清单，并只写一份唯一命名的 `.reviews/<YYYY-MM-DD>-<HHMMSS>.md` 工作产物，**不改任何长期上下文文件**；需要用户知识才能判断的行（数字是否变了、承诺是否完成）单独标出；
- 用户点名后执行：写到哪个文件由该 Bot 自己的 `BOT.md` `## Updating` 决定，怎么写（元信息、写锁）一律照 `bot-turn/writing.md`——写入协议只有一处定义；
- 目录过大时分批检查，并说明本次覆盖范围；
- 每轮（包括普通 `@bot` 调用）在汇报末尾列出本轮读过与改过的文件，作为"这次回答基于什么"的最小可审计记录。

**唤醒**：Bot 自身不会醒来，`next-check` 只在有人读 `commitments/active.md` 时才起作用——多数 Bot 到此为止就够了。只有当承诺确实会被漏掉时，skill 才提一次"可以建个定时任务发 `@name 检查 next-check 已过的承诺`"，建不建由用户决定，skill 不代建、也不重复提。定时任务走的是同一条 `dispatchChat` → `resolveCommandPrompt` 路径，因此 `@bot` 会照常派出 subagent。

### 3.4 导出

入口是 `@name 导出为 <路径>`（`bot-turn/export.md`）：读源 Bot，在**另一个目录**生成一个新 Bot，交给别人用。源目录只读不改。

- **为什么不是直接分享运行目录**：运行目录里有写锁、复盘产物、这个用户的记忆，以及只在这台机器上成立的绝对路径。整份拷出去等于把这四样一起给了陌生人，而产物通常进公开仓库，泄漏不可逆。
- **为什么是 `@name` 而不是 `/bot clone`**：`/bot` 只负责创建，对已存在 Bot 的操作一律寻址到 Bot 自己（§2）。更实质的理由是导出是**判断**而非拷贝——哪条 fact 是通用经验、哪条是这个用户的，只有通读过整个目录的会话能分辨，而那正是复盘已经在做的事；主会话执行则要么退化成机械 `cp -r`，要么把目录重读一遍。
- **白名单而非黑名单**：只带 `BOT.md` + `identity/` + `skills/`，其余目录重建为空骨架，其它一切默认不带。理由是 Bot 目录会长出新东西——一张"不要带"的清单在它长出 `notes/` 的那天就漏了。被拒的内容按文件报条数，由用户点名追加，这是导出唯一碰记忆内容的时刻。
- **改写 `BOT.md`**：`name` 取目标目录名（不改则接收方注册时直接撞名被拒）；`## Before working` / `## Updating` 原样保留（那正是被分享的操作手册）；`## Skills` 逐行看——名字和相对路径**原样不动**（它们本来就是可移植的，这正是 §3.2 写名字的回报），绝对路径则反查 `GET /api/skills`，能对上就换成那个 skill 的名字，对不上就保留并在报告里标"只在作者机器上成立"。
- **报告要给出"接收方需要装什么"**：导出后的 Skills 表引用的全部 skill 名字，就是这个 Bot 的安装需求清单——按名字各注册一份即可。
- **不取写锁**：产物写在源 Bot 之外，和 `.reviews/` 同属工作产物。唯一要避免的是回头往源 Bot 里记一笔"我导出过"——那是写，照 `writing.md` 走。
- **不自行注册**：与 `/bot` 一致，说出路径和两种注册方式即止。产物多半要先进仓库再给别人，自动注册等于替用户判定它属于这台机器。
- 凭证永不进产物：`secrets/`、`.env*` 不打开不复制；`identity/` 与 `skills/` 是手写的，通读时发现疑似凭证就停下报告，不写进产物。

## 4. 创建与注册

- **创建**：内置 skill `skills/bot/SKILL.md`。先对齐 Bot 用途，再告知名称与目录（用户指定目录 → `<dir>/<name>/`；否则 `{{COCKPIT_DIR}}/bots/<name>/`，派发时替换为实际数据目录），经确认后写文件。skill 不自行注册。
- **注册**（与 skill 一致）：
  - Bots 面板 → 添加 Bot → 粘贴 Bot 目录或 `BOT.md` 的绝对路径；
  - 文件浏览器 / Markdown 预览中打开 `BOT.md` → "添加为 Bot" 按钮。
- **移除**：只删除 `bot.json` 记录，目录保留。
- 注册表变化通过 `cockpit-bots` BroadcastChannel 刷新所有输入框的 `@` 补全。

`bot.json`：

```json
{ "bots": [{ "id": "bot-<uuid>", "path": "/abs/bot/dir", "addedAt": "..." }] }
```

注册校验：路径为绝对路径、目录存在（存 realpath）、`BOT.md` 可读且 name 合法；同一目录重复添加返回 `alreadyExists`；与其他有效 Bot 重名时拒绝。

## 5. 接口与代码

| 位置 | 作用 |
| --- | --- |
| `GET /api/bots` | 列出 Bot：`{valid:true, name, description}` 或 `{valid:false, name, error}` |
| `POST /api/bots` | 注册目录或 BOT.md |
| `DELETE /api/bots/:id` | 移除注册 |
| `packages/feature/agent/src/shared/bots.ts` | 纯函数：`parseBotDocument` / `botPaths` / `resolveBot` / `mentionableBots` / `findNameClash`；路径 API 由调用方注入（`node:path`），兼容 Windows |
| `packages/feature/agent/src/effect/botRegistryLive.ts` | `BotRegistryService` Live：list / add / remove（Effect.gen，错误全部为 typed failure） |
| `packages/feature/agent/src/server/lib/slashCommands.ts` | `@bot` 识别与渲染（同步读取 `bot.json`，经同一 `resolveBot` / `mentionableBots`） |
| `packages/feature/agent/src/client/commandAutocomplete.tsx` | `@` 只列 Bot；`/`、`/@` 只列 skill |
| `packages/feature/workspace/src/client/BotsModal.tsx` | 搜索、按路径添加（`AddBotDialog`）、移除（memo `BotCard`） |
| `packages/feature/explorer/src/client/registry/` | `useAddToRegistry` + `useAddSkill` / `useAddBot`：SKILL.md / BOT.md 添加按钮 |
| `packages/shared/api/src/botsRegistryClient.ts`、`botsBus.ts` | 浏览器 client 与跨 frame 刷新；共用 `httpJson.ts`（含 `failureMessage`）与 `changeBus.ts` |
| `packages/shared/utils/src/paths.ts` | `readJsonFileForUpdate`：缺失 → 默认值，**损坏 → 抛错**。凡是结果会被写回的读取都用它（`bot.json` / `skills.json` / `html-apps.json` / `projects.json` / `scheduled-tasks.json`，以及 `mutateJsonFile` 内部）；`readJsonFile` 两种情况同一出口，只适合读完即弃 |
| `packages/feature/agent/src/server/lib/builtinSkills.ts` | `listBuiltinSkillExtras` / `readBuiltinSkillExtra`：`skills/<cmd>/` 下除 SKILL.md 外的 `*.md`，随 SKILL.md 一起复制并替换占位符（渐进式加载的载体；注册表只认"含 SKILL.md 的目录"，加参考文件不会冒出新命令） |
| `skills/bot/SKILL.md` | 内置 skill：**只负责创建** Bot（`/bot`）|
| `POST /api/sessions/delegate` | 起子会话。`engine` 省略时继承发起方（`x-cockpit-run-id` → run registry → `spec.name`），只有它才知道这轮聊天走的哪条路由 |
| `packages/feature/agent/src/server/sessionRunHub.ts` | `RunState.engine` + `getRunInfo`：上面那条继承的唯一数据源。`engine` 与 `sessionId` 相互独立，否则新会话第一轮就读不到 |
| `skills/bot-run/SKILL.md` | 隐藏内置 skill，**派发方**读，常驻部分：主会话/子会话分流 + 分流表 + 写 brief + delegate + 汇报 |
| `skills/bot-run/wait.md` | 按需：轮询循环、预算、状态语义。**POST 返回后、发任何 status 之前必读** |
| `skills/bot-run/followup.md` | 按需：往已存在的子会话续发消息（而不是再派发一个） |
| `skills/bot-turn/SKILL.md` | 隐藏内置 skill，**执行方**读，常驻部分：分流表 + 读取规则 + 汇报规则 |
| `skills/bot-turn/writing.md` | 按需：条目元信息、写入门槛、写锁。**改 Bot 文件前必读** |
| `skills/bot-turn/review.md` | 按需：复盘十一类检查、矛盾分类、`.reviews/` 落盘 |
| `skills/bot-turn/attach.md` | 按需：往 Skills 表加一行 |

## 6. 测试

- `slashCommands.test.ts`：多 `@bot` 渲染与两块引用清单（read / handoff 分组与组内顺序）、单个 `@bot` 也显示 locus、与 `/`、`/@` 混用、未注册名 / 旧 `@skill` / 大写名保持原文、纯 skill 消息沿用原标题；两条降级用例——`bot-run` 写不出时内联正文、`bot-turn` 写不出时整条消失且不内联；参考文件被复制到解析后目录且占位符已替换（每种占位符各一条正向断言，只断言"不含 `{{`"在一个本来就没占位符的文件上会假通过）；**两种静默降级都在消息里说出来**——旧写法 `@cr`、以及 `bot.json` 解析失败时的每一行 `@name`。
- `slashCommands.test.ts`（本地执行那一组）：cwd 等于 Bot 目录时渲染 `[main·@name]`、`BOT.md` 进"要读的"块且 `bot-run` 整条不出现；尾斜杠与符号链接（`os.tmpdir()` 在 macOS 上本就是软链，天然覆盖）仍命中；子目录与上级目录都**不**命中（后者是"仓库根下有 `bots/`"那条护栏）；一条消息里一本地一派发的完整输出（`bot-turn` 两块各一次、转交块换标题）；`bot-turn` 写不出且有本地行时**内联**——与派发时"整条消失"正好相反，因为读者换人了。
- `delegationLive.test.ts`（引擎继承那一组）：取父 run 的引擎；父会话**还没有 sessionId 也要取到**（这条守的就是"别复用 `resolveParent`"）；无头 / 未知 run / 不可派发引擎三种回落 claude；显式 `engine` 永远压过继承，而显式写错仍然 400。
- `bots.test.ts`：frontmatter 解析、目录名回退（含 Windows）、非法名称拒绝、POSIX / Windows 路径互转、无效 Bot 保留原因、重名时先注册者生效、重名检测排除自身。
- `botRegistryLive.test.ts`：按 BOT.md 注册与重复添加、相对路径 / 目录不存在 / 缺 BOT.md / 重名拒绝、失效 Bot 列为无效、移除只删记录不删文件、重复移除返回 NotFound；**损坏的 `bot.json` 不被覆盖**（add 失败、list 也失败、文件字节原样）；**EACCES 不报成 not found**（errno 必须活着传出来，否则用户会去找一个明明在眼前的目录）。
- `scheduledTasks.corrupt.test.ts`：损坏的 `scheduled-tasks.json` **既不静默清空、也不拖垮启动**——`init()` 正常返回、不起任何定时器、大声记日志、文件字节原样；写入路径照常拒绝。`server.mjs` 那句 `await scheduledTaskManager.init()` 没有 error boundary，这条用例守的就是它。

这些用例都验证过"去掉修复就会红"，不是事后补的同义反复。
