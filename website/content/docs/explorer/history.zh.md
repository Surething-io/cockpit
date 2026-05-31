**Git 历史** 标签加上几个相关视图 —— 分支、worktree、blame —— 让你回溯谁、什么时候、为什么改了什么。

| 章节 | 内容 |
|---|---|
| [提交日志](#提交日志) | 最新在前,点击看 diff |
| [分支](#分支) | 切换 / 创建 / 删除,本地 + 远程 |
| [Worktree](#worktree) | 并行 checkout,每任务一个 |
| [Blame](#blame) | 逐行作者归属 |

## 提交日志

**历史**标签显示**当前选中分支**的提交日志,新的在上。默认选中分支是 HEAD 所在分支,但你可以从顶部分支选择器切到任意其它分支只看它的日志 —— 不会动你的 git HEAD(纯查看器)。

每行带:

- 短 hash
- 作者名
- 日期(带"2 小时前"的相对时间)
- 提交主题(第一行)

点一个提交,Explorer 右侧展开**提交详情面板** —— 完整消息、改动文件树、逐文件 diff。点文件树里任意文件滚到对应 diff。

切到别的分支用顶部的分支选择器;见[分支](/zh/docs/explorer/history/#分支)。

### 历史**不**做什么

跟变更 tab 同样的"查看器,不是编辑器"理由:

- **不能从 UI cherry-pick**。
- **没有 revert、reset**。
- **没有 rebase 控制**。
- **没有单文件历史视图**(不能在 Cockpit 里问"哪些提交动过这个文件?")。

这些都去终端做。

### 大仓库

提交按 **50 条一页**懒加载 —— 滚到列表底部自动拉下一页(代码里 `handleCommitListScroll` 触发,前提是 `hasMoreCommits`)。

Blame 端没有特别的缓存或限流 —— 直接走 `git blame`。超大文件第一次 blame 可能花几秒。如果性能成问题,这是要去终端用 `git blame -L` 限范围的信号。


## 分支

Cockpit 有一个分支选择器，让你切换 Explorer 面板显示的内容 —— 想看一下另一个分支的文件树、状态、历史时有用。

### 在哪

打开 Explorer → **History** tab。顶部的分支名就是选择器。点它打开可搜索的下拉。

### 你看到什么

下拉列出所有分支,分三组(按顺序):

- **Pinned 分支** —— 你 pin 过的几个常用分支(如果有的话),始终在最上面,跨 session 保留。
- **本地分支** —— 仓库里所有本地分支。
- **远程分支** —— 远程存在的分支(比如 `origin/feature-x`)。

当前 git HEAD 所在的分支在列表里标 **(Current branch)**。顶部搜索框边打边过滤,几百个 feature 分支的仓库很有用。

### 点分支会做什么

点下拉里的某个分支，**History tab 用那个分支重新加载** —— 你看到它的提交日志，点提交看那个分支的 diff。

它**不会** check out 这个分支。你的工作树、当前 `HEAD`、Status 里的内容都保持在你原来的分支上。分支选择器是个查看器。

要真的 check out 一个分支，去终端跑 `git checkout` / `git switch`。

### **没有**的功能

Cockpit 的分支 UI 有意做轻。下面这些 UI 里没有 —— 用命令行 Git 做：

- 新建分支
- 删除分支（本地或远程）
- 跟远程对比 ahead / behind
- Tag 管理
- Stash 管理

### 分支需要各自工作目录时

如果你经常要在分支间切换 **并且** 想保留每个分支的工作目录完整（特别是有构建在跑），看 [Worktree](/zh/docs/explorer/history/#worktree) —— Cockpit 能在 UI 里创建和管理 Git worktree，比频繁 check out 不同分支顺手得多。


## Worktree

Git worktree 是一个独立的工作目录，跟你主 checkout 共享同一份 `.git` 数据。一个仓库可以有多个 worktree，每个 worktree 在不同分支、各自有磁盘上的文件 —— 想看别人分支时不用 stash 再切。Cockpit 有专门的模态做创建、切换、删除 worktree。

### 打开 worktrees 模态

从 Explorer 的分支选择器区域（或项目菜单）打开 **Git Worktrees**。模态列出当前仓库的每个 worktree：

- 分支名（或 `detached` 表示指向具体提交）
- 完整文件系统路径
- 🔒 锁定图标（如果被锁了）
- 当前正在用的那个标 **(Current)**

### 创建 worktree

两种方式：

#### 快速 —— 让 Cockpit 替你命名

点 **Add Worktree**。Cockpit 挑一个默认分支（依次试 `origin/main`、`origin/master`、`main`、`master`），基于它创建新分支 + worktree。分支名格式是 `<你的 git 用户名>/<随机词>`，比如 `alice/tepid`。目录放在你主 checkout 旁边。

想要个全新实验分支、不在乎叫什么时用这个。

#### 从已有分支

点 **Select Branch**。可搜索列表显示所有本地和远程分支 —— 已被其它 worktree checkout 的分支除外（Git 只允许一个 worktree 用一个分支）。选一个；Cockpit 创建一个指向它的 worktree。

### 切换到某个 worktree

点列表里任意 worktree(不是当前那个),Cockpit 把那个路径**作为一个新项目加进同一个 Cockpit 窗口** —— 顶部项目栏多出一个 tab,自己有完整的 Agent / Explorer / Console。原来的 worktree tab **保留在项目栏里**,可以随时切回。所以是"同窗口、多项目 tab"的并排,不是开新窗口。

### 锁定 worktree

在任何非当前 worktree 上点锁图标。锁定后阻止 Git 自动 prune 它（`git worktree prune` 跳过锁定的）。何时用：

- worktree 在慢的 / 可移除的卷上，不总是挂着。
- 你停一个半完工的分支，不想把它弄丢。

再点解锁。

### 删除 worktree

点 worktree 上的删除按钮。Cockpit 弹确认对话框，显示路径和分支名，防你不小心删错。确认后就没了。

这会删除 worktree 的目录和 Git 注册。分支本身留着 —— 之后还可以从这个分支重建 worktree。

### 为什么用 worktree

实际中的最大收益：

- **并行评审** —— 把队友的 PR 分支作为 worktree 打开，自己分支的 IDE / 构建状态完全不动。
- **长构建** —— `main` 上启动构建，切到独立 worktree 的 `feature-x`，免去 `git stash` 折腾。
- **AI 驱动分支** —— 让 agent 在自己的 worktree 里做一个分支；你在自己分支上并行工作。

代价：每个 worktree 工作目录占自己的磁盘空间。`.git` 数据是共享的。


## Blame

Blame 视图告诉你文件每一行是谁写的、什么时候、属于哪次提交。看到不熟的代码想问"该问谁"时用它 —— 或者追查一个回归是什么时候引入的。

### 打开

在 Explorer 代码查看器里打开任意文件。点文件头部的 **Blame** 按钮。

Cockpit 给每行加上 blame 标注。按 `Esc`（或再点一次 Blame）关闭。

### 标注显示什么

行号旁边出现一窄列。每行你看到：

- 作者名
- 提交的短 hash
- 格式化的日期（悬停看完整时间戳）

同一次提交的连续行视觉上被分组 —— 一个 20 行的函数你看到一个大的"Alice，2 周前，fa3b21"块，不是 20 行重复。这种块状能让有意义的边界（作者变化的地方）跳出来。

悬停 blame 行看 tooltip，里面是完整提交主题。

### 从 blame 跳到提交

点 blame 行 Cockpit 打开那次提交的**提交详情面板** —— 完整消息、提交里的所有文件、逐文件 diff。这是经典的"Alice 写这块时还动了什么？"工作流。

### 常见用法

- **找该问的人** —— blame 一个看不懂的函数，往上看作者，问她。
- **追回归** —— git-bisect 的可视化版本：blame 坏的那行，跳到它的提交，看 diff。
- **回顾近期改动** —— blame 一个几个月没碰的文件，看哪些行是最近加的。

### **没有**的功能

- **没有作者过滤**（"只显示 Alice 写的行" —— 没实现）。
- **没有日期过滤**（"只显示今年的改动" —— 没实现）。
- **没有"忽略空白"开关** —— 格式化提交跟有意义的提交混在一起。

更深度的 blame 工作（特别是 `git log -L` 那种"这几行的历史"），去终端。

### 大文件性能

Blame 端**没有内置缓存或限流** —— 每次开 blame 都直接调一次 `git blame`,大文件可能花几秒。性能成问题的话,这是去终端用 `git blame -L 100,200 <file>` 限行范围的信号。

