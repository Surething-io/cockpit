**Skills** 是你在 Agent tab 里用 `/` 触发的短 prompt —— 每个 Skill 改变 AI 这一次回复的工作方式。Cockpit 内置 **6 个 Skills**(`/qa /fx /ex /go /cg /cc` 模式);你也可以写自己的 `SKILL.md` 文件,同样的方式装上。两种 Skills 共用一个 `/` 菜单。

> 不要跟**笔记**（项目笔记编辑器）里的斜杠菜单搞混 —— 那个是标题/列表/表格之类的格式化菜单。聊天输入框只识别 Skills；在聊天里打 `/` 弹出的菜单只有 `/qa /fx /ex /go /cg /cc` 加你装过的 `/skill-name`。

## 6 个内置 Skills

| 命令 | 意图 | 反问吗？ | 写代码吗？ |
|---|---|---|---|
| **`/qa`** | 需求澄清 | ✅ 是 | ❌ 否 |
| **`/fx`** | bug 证据链分析 | ❌ | ❌ |
| **`/ex`** | 深度结构化讨论 | ❌ | ❌ |
| **`/go`** | 执行 / 落地模式 | ❌ | ✅ 是，含自验证 |
| **`/cg`** | CodeGraph 项目探索 | ❌ | ❌ |
| **`/cc`** | 通过 Cockpit CLI 端到端验证 | ❌ | ❌(驱动气泡,不直接改代码) |

## `/qa` —— 改任何东西前先澄清

适用：你即将要求一个代码改动，但需求还不够清晰。

```text
/qa 我想让文档侧栏行为更像 Cursor 的
```

AI 会：

1. 说出它理解的你的诉求。
2. 列出模糊的部分。
3. 提出编号问题，期待你回答之后再碰任何文件。

它遵循 KISS，并且**在这个模式下从不写代码**。输出只有"理解 + 问题"。任何非琐碎特性都该从这里入。

## `/fx` —— 构建 bug 证据链

适用：你有一个症状，需要追到根因。

```text
/fx 文档页在某些 session 的代码块里渲染成 ",[object Object],"
```

AI 会：

1. 形成假设。
2. 检查涉及的代码路径。
3. 把证据列出来 —— 什么触发什么，逐行。
4. 给出最小复现 + 根因，先不提修复建议。

诊断敲定后配合 `/go`。

## `/ex` —— 深度结构化讨论

适用：你想要分析但不希望被反问打断。`/ex` 就是 `/qa` 去掉反问 —— 产出一份长的结构化讨论文档。

```text
/ex 对比这个接口的三种缓存策略
```

适合设计文档、RFC、对比分析。

## `/go` —— 落地改动

适用：方案已定，你要 AI 真的去做。

```text
/go 给 /api/heavy-endpoint 加上 60 秒 TTL 的 Redis 缓存
```

`/go` 模式：

1. 把工作切成 MVP 大小的阶段，每个阶段独立可交付可验证。
2. 写代码、跑验证（类型检查、测试、打接口等），输出阶段交付总结 + 验证报告。
3. **自动进入下一阶段** —— 阶段之间不等签字。
4. 只在三种情况停下：阻塞性歧义（缺关键 API 契约）、破坏性操作（`git push --force`、drop table 等）、调研结论没覆盖到的关键选型分叉。
5. 全部完成后做一次端到端回看。

写代码时间最多的就是这个模式。在 `/qa` 或 `/ex` 把方案敲定后用。

## `/cg` —— 把项目当图来探索

适用：你需要理解代码结构而不想把所有东西 grep 一遍。

```text
/cg 哪些 handler 调用了数据库适配器？
```

`/cg` 把 AI 切到读 Cockpit 本地的 **CodeGraph** —— 一份项目的结构索引（谁调用什么、什么调用谁、哪些文件经常一起改），不再让它对每个文件做暴力 grep。回答更快，也更聚焦。

图在你第一次问的时候自动构建。没有安装步骤,不用配项目。当前支持 TypeScript / JavaScript / Python / Go / Rust(基于 tree-sitter,不依赖 LSP,所以 Go/Rust 不需要装 language server)。

## `/cc` —— 通过 Cockpit CLI 端到端验证

适用:代码改完了,要让 AI **真的**去跑一下、看 UI、抓网络、确认行为对了。

```text
/cc 终端: cock terminal abc123
    浏览器: cock browser xyz789
    测一下 chat 输入框的发送功能,验证消息能正确入库且 UI 实时刷新
```

`/cc` 把 AI 切到**操作 Cockpit CLI** 的模式 —— 把 `cock terminal <id> output` 拿终端输出、`cock browser <id> click/type/network` 等驱动浏览器气泡当作主要工具。你需要在 prompt 里给它**短 ID**(在终端 / 浏览器气泡头部点徽章拿到)指明要驱动哪些气泡。

通常配合 [`/go`](#go-落地改动) 使用 —— `/go` 写完代码,`/cc` 验证它确实活在用户那一侧。详细 walkthrough 见[快速开始](/zh/docs/get-started/quickstart/#端到端验证-console-拉起服务-cc-测试)。

## 模式：串成链

典型的端到端任务把模式串起来：

```text
/qa 我们要给重接口加缓存                        ← 澄清
/cg 哪些 handler 碰了 /api/heavy-endpoint？     ← 发现代码
/fx 为什么这个接口慢？                           ← 分析
/go 加上 60 秒 TTL 的 Redis 缓存                ← 执行
```

入口取决于你手里有什么：

- 模糊目标 → `/qa`
- 症状 → `/fx`
- 代码相关问题 → `/cg`
- 想要不被打断的分析 → `/ex`
- 方案已定 → `/go`

> 上面 6 个内置 Skills 就是 Cockpit 带的全部。要做你自己的重复工作流，看下面的[自定义 Skills](#自定义-skills) —— 它们出现在同一个 `/` 菜单里，叫 `/skill-name`。

## 自定义 Skills

自定义 Skills 是你自己的斜杠命令 —— 跟上面 6 个内置模式同一回事，只是 prompt 是你自己写的。在聊天里以 `/你的-skill-名` 触发。

如果你发现每周都在向 Claude 粘贴同一段长指令 —— "按这几条具体规则审查这个 PR"、"按这个格式总结提交"、"跟着这个调试 checklist 走" —— 把它做成一个 Skill，一次性、永久复用。

### Skill 是什么

一个 Skill 就是一个名为 `SKILL.md` 的 Markdown 文件。文件顶部是一小段 YAML 风格的元信息，给这个 skill 命名和描述；文件正文是 prompt 本身。

最简示例：

```markdown
---
name: pr-review
description: 按我们团队的 checklist 审查 PR
icon: 🔍
argument-hint: "[PR 编号或 URL]"
---

你在审查我们团队的一个 pull request。请检查：

1. 测试有没有覆盖新行为
2. 公共 API 有没有破坏性改动
3. changelog 里有没有迁移说明
4. 提交信息是不是大白话

输出结构化评审：摘要、阻塞项、建议、通过/拒绝。
```

这个文件可以放在你电脑的任何位置 —— Cockpit 不会移动它。

| 字段 | 必填？ | 作用 |
|---|---|---|
| `name` | 是 | 斜杠触发名。这里就是 `/pr-review`。空格变破折号。 |
| `description` | 是 | 聊天下拉菜单里显示的一行说明。 |
| `icon` | 可选 | 下拉里名字旁边的 emoji。 |
| `argument-hint` | 可选 | 提示文本，比如 `[PR 编号或 URL]`，下拉里显示，提醒你斜杠命令后该打什么。 |

### 在 Cockpit 里安装一个 Skill

1. 打开 **Skills** 模态（从侧栏或应用菜单）。
2. 点 **+ 添加 Skill**。
3. 粘贴**你 SKILL.md 文件的绝对路径**（比如 `/Users/me/skills/pr-review/SKILL.md`）。
4. 回车。

Cockpit 校验文件存在并读取 frontmatter。如果有问题（文件不存在、frontmatter 格式错），skill 卡片上会显示 `[Invalid]` 角标。

要删除某个 skill，鼠标悬停到卡片上点垃圾桶图标。

> Cockpit 不复制文件 —— 只记住路径。如果你移动或重命名了 SKILL.md，这个 skill 就不工作了，要删掉旧的、用新路径重新加。

### 使用一个 Skill

装好后在任意 Agent tab 打 `/`。聊天下拉显示两个分组：

- **Commands** —— 6 个内置 AI 模式命令。
- **Skills** —— 你装过的全部，带图标和参数提示。

输入即过滤,回车或 Tab 插入。聊天输入框被填成 `/你的-skill-名 `(末尾带空格,方便你接着打参数)。打完参数回车发送。

AI 收到的是你 skill 的 prompt 正文加上你的参数 —— **斜杠后面打的所有内容**都会作为 argument 拼到 skill body 之后。没有特殊权限、没有第二个菜单,就是"每次粘同样 prompt"的更优雅版本。

### 跟团队分享

一个 Skill 就一个文件。要跟队友分享，把 SKILL.md 发给他（或推到一个共享仓库）。他用同样的方式加 —— 粘路径、完事。

有些团队会维护一个共享的 `~/team-skills/` 目录，每个人的 SKILL.md 各放一个子目录里。这样加新 skill 就是 `git pull` 然后在 Cockpit 里 **+ 添加 Skill**。

### 跨 tab 即时同步

你在一个 tab 加或删 skill,所有其它已经打开的 Cockpit tab 的 `/` 菜单**立刻**更新 —— 不需要刷新。底层走浏览器原生的 `BroadcastChannel('cockpit-skills')`,纯客户端、零延迟、不经服务端。

## 下一步

- [CodeGraph（/cg）](/zh/docs/explorer/search/#codegraph) —— `/cg` 的 API 实际返回什么
- [会话管理](/zh/docs/agent/sessions/) —— 斜杠命令在整个聊天流程里的位置
