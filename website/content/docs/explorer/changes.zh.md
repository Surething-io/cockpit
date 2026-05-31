**变更** 标签展示你的 Git 工作树 —— 哪些已 stage、哪些没,以及 Cockpit 的并排 diff 查看器。提交前 review 所有改动（你的 + AI 的）就在这里。

| 章节 | 内容 |
|---|---|
| [Status 面板 —— 工作树](#status-面板--工作树) | 两个分组（Staged / Unstaged）；stage / unstage / discard |
| [Diff 视图](#diff-视图) | 始终并排；行号；Compact 折叠；行内评注；minimap |

## Status 面板 —— 工作树

打开 Explorer（`Cmd+2`）→ **变更** 标签。文件按**两个分组**展示:

| 分组 | 装什么 |
|---|---|
| **Staged**（已暂存） | 已加入 Git index 的改动,准备提交。 |
| **Unstaged**（工作区） | **包括两类**:相对上次提交修改但未 stage 的文件,以及 Git 还没见过的 untracked 新文件。后者在行里以 `?` 图标区分。 |

### 批量按钮（按分组不同）

各组头部的按钮不一样,只显示该分组上下文里能干的事:

| 分组 | 头部按钮 |
|---|---|
| **Staged** | **Unstage All** —— 一键把全部 staged 文件退回工作区。 |
| **Unstaged** | **Stage All** + **Discard All** —— 一键 stage 全部,或丢弃全部未保存的改动。 |

### 单行操作

把鼠标悬到任意文件行上,行尾露出一个对应按钮:

- Staged 行 → **Unstage**(把它退回工作区)。
- Unstaged 行 → **Stage**(加进 index)。

discard 单文件目前没有行级按钮 —— 走分组 **Discard All**,或者用终端做 `git restore <file>` / `rm <file>`。

### 选中文件看 diff

点任意分组里的任意文件,右侧 pane 进入 **Diff 视图**。

不同分组的对比基准不一样:

| 选中类型 | 旧版本 = | 新版本 = |
|---|---|---|
| **Staged 文件** | HEAD（上次提交版本） | 已 stage 版本 |
| **Unstaged 文件** | 已 stage 版本（如果存在;否则 HEAD） | 工作树（磁盘上文件） |

意思就是:已 stage 一部分改动后再继续编辑,Unstaged diff 只显示**新加的**改动,而不是从 HEAD 起的全部。

### 没有 commit 输入框

**Cockpit 不替你 commit。** 没有 commit 消息输入框,也没有 commit 按钮。在 Status 面板里 stage 好文件,然后在任意终端跑 `git commit` —— 你的 shell、Cockpit 终端气泡、你的 IDE,哪儿都行。

这是有意的:长格式 commit 消息基本不该塞进单行输入框,而且 Cockpit 也不想跟你已有的 commit 约定和 hook 打架。


## Diff 视图

Cockpit 渲染所有文件改动 —— 不管是 **变更** 标签里的 staged / unstaged,还是 **历史** 标签里某次提交里的文件,还是技术方案评审里的行级锚点 —— 都走同一个 **Diff 视图**。

### 总是并排

DiffView 永远以 **并排** 形式渲染:旧版本在左、新版本在右,两边各自有横向滚动条,但纵向滚动同步。**没有"内联"模式可切**。

两边都显示原文件和新文件的行号,改动按行高亮（绿色 = 加,红色 = 删）。

### Compact 模式（仅 Status 面板默认开）

**变更** 标签的 diff 默认走 **Compact** 模式 —— Cockpit 只渲染改动行加 **3 行上下文**,把每段长的未改动代码折叠成可点击的"`+N` 行"标记。点任意标记,两个方向各展开 20 行;再点继续展开。

Compact 视图右上角有一个 **Compact / Full** 切换 —— 想看完整文件就一键切到 Full。

**其它入口**（比如 **历史** 标签的提交详情、独立 diff 模态等）**默认 Full**,不开 Compact。这是为了在浏览历史 diff 时一次就看到完整文件。

### Minimap

DiffView 右边缘有一条 **minimap** —— 整文件浓缩成竖条,**绿是加、红是删、灰是未改**。点 minimap 任意位置跳过去。在长 diff 里快速发现重要改动很有用。

### 冲突

Git 留下冲突标记（`<<<<<<<` / `=======` / `>>>>>>>`）时,Diff 视图当作普通文本渲染,不做特殊处理。解决冲突就用你常用的编辑器打开文件挑一边 —— Cockpit 没有内置 merge 工具。保存后回到 **变更** 标签重新 stage。
