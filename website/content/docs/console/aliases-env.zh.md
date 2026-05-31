两个让 Console 顺手得多的小功能:**别名**(给长命令起短名)和**环境变量**(给当前 tab 设值,命令运行时能读到)。

## 别名

别名把一次性命令的**首词**替换成另一串。比如设:

| 别名 | 展开为 |
|---|---|
| `ll` | `ls -la` |
| `gs` | `git status` |
| `gp` | `git push` |
| `gc` | `git commit` |

那么打 `ll src/` 跑 `ls -la src/`。打 `gs` 跑 `git status`。**只替换首词** —— 后面的保持原样。Cockpit 首次启动时自带这几个常用别名,直接可用。

**作用域:全局。** 别名跨所有项目、所有 tab 通用,改动下一条命令立即生效,不用重启。

**别名管理器:Cockpit 顶栏**右侧的小图标(不是 Console 输入栏里那个 —— 那个是环境变量管理器)。在弹出的弹窗里:

- 已有别名一行一项:左边是 `$ <名字>`(只读),右边是命令(可直接编辑改它的展开形式)。鼠标悬停行尾出现 🗑 删除。
- 底部一行 + 号添加新别名:左边名字、右边命令、回车保存。
- 没有"临时禁用"开关 —— 只有添加 / 编辑 / 删除。

**别名也会作用于**:重跑(▶ 按钮)和[快捷命令](/zh/docs/console/input-bar/#快捷命令-按钮左于输入框)里保存的命令 —— 因为它们走的是同一套调度顺序。

**别名不会作用于**:交互式 shell(`zsh`、`bash` 等 PTY 命令)。这些直接进 PTY,用你 shell 自己的 alias 设置。

## 环境变量

环境变量在当前 tab 的 Console 面板里生效 —— 这个 tab 下跑的每个命令都会预先注入这些 `KEY=VALUE`。

**作用域:每个 tab 独立。** 每个 tab 一份自己的环境变量,存在该 tab 自己的文件里;你切到另一个 tab 是完全不同的一份。

**环境变量管理器:Console 输入栏工具栏**的 `{x}` (Variables) 图标。打开后:

- 顶部副标题显示当前作用域("Tab scope")。
- 已有变量一行一项:左 KEY(只读)、右 VALUE(可编辑)、🗑 删除。
- 底部一行添加新变量:KEY、VALUE、回车或 + 号确认。
- 点 Save 保存到磁盘 —— 下一条命令立即生效,无需重启。

### 典型场景

- **每个 tab 不同的 API key** —— 测试 tab 里 `STRIPE_API_KEY=sk_test_...`,生产工具 tab 里 `STRIPE_API_KEY=sk_live_...`。两个 tab 各跑各的,没有混线风险。
- **每个 tab 不同的数据库 URL** —— `DATABASE_URL=postgresql://localhost/dev_db` 在 dev tab,`…/staging_db` 在另一个 tab。
- **跨 tab 都需要的工具路径** —— 比如 `PATH=/opt/homebrew/bin:$PATH`。**这个需要在每个用到的 tab 里都设一遍**(每个 tab 一份独立 env)。

### 变量展开

Cockpit 把 VALUE 当**字面字符串**写进子进程环境 —— 不展开 `$VAR`、不展开 `~`、不解析引号。如果你想要 `PATH=/opt/homebrew/bin:$PATH`:

- 在 VALUE 里**字面**输入 `/opt/homebrew/bin:$PATH`
- 运行时:Cockpit 把这个字面字符串塞进 `PATH` env,**shell 执行命令时**才把 `$PATH` 展开成真实 PATH。

## 存哪儿

一切都在本地完成。别名是全局的,跟你这台机器走;环境变量按 tab 分文件,放在 Cockpit 数据目录里。换新机器时把 Cockpit 数据目录复制过去,别名和所有 tab 的环境变量都跟着走。

## 常见问题

- **别名没展开** —— 别名只对一次性命令的**首词**生效。在交互式 shell(`zsh`、`bash`)里输入的命令走 shell 自己的 alias,不走 Cockpit 的。
- **新开终端里环境变量"没设"** —— 交互式 shell 是子进程,能继承 Cockpit 注入的 env,但里面 `export` 的不会回流到 Cockpit。
- **VALUE 里的 `$VAR` 没展开** —— 设计如此。Cockpit 不做 shell 展开,把字面字符串交给 shell,由 shell 命令运行时展开。
- **切到另一 tab 后变量不见了** —— 每个 tab 一份独立 env。要让多 tab 都有同一个变量,需要在每个 tab 里都设一遍。

## 下一步

- [命令输入](/zh/docs/console/input-bar/) —— Console 怎么挑气泡,以及别名在调度顺序里的位置
