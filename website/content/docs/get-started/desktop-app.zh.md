OpenCockpit 桌面 App 支持 macOS 和 Windows，让 Cockpit 有自己的窗口和程序坞 / 开始菜单图标。它是本机 Cockpit 的一个窗口，不是第二个服务：用的是你通过 npm 安装的 Cockpit，需要时把它启动起来，关掉窗口后服务继续运行。

## 安装

先装好 Cockpit 本身（[Node.js 22.19.0 或更高版本](https://nodejs.org/zh-cn/download)，再执行 `npm i -g @surething/cockpit`），然后：

```bash
cockpit app install
```

它会从 GitHub Releases 下载与当前 Cockpit 版本完全对应的 App，用 npm 包里附带的 SHA-256 校验，然后安装到：

| 系统 | 位置 |
|---|---|
| macOS | `~/Applications/OpenCockpit.app` |
| Windows | `%LOCALAPPDATA%\Programs\OpenCockpit`，并在开始菜单建快捷方式 |

之后像其他应用一样打开。Linux 没有桌面 App，可以把网页装成[网页应用（PWA）](/zh/docs/get-started/quickstart/#或者装成网页应用pwa)。

### 手动下载

每个 [GitHub Release](https://github.com/Surething-io/cockpit/releases) 都附带 `.dmg`（macOS）和 `.zip`（Windows），校验和在 `SHA256SUMS` 里。App **没有代码签名**，所以通过浏览器下载的文件第一次打开时会被系统拦一次：

- **macOS**：先打开一次并关掉警告，再到**系统设置 → 隐私与安全性**点**仍要打开**；或者执行 `xattr -dr com.apple.quarantine /Applications/OpenCockpit.app`。
- **Windows**：解压到任意位置后运行 `OpenCockpit.exe`，在 SmartScreen 弹窗里点**更多信息 → 仍要运行**。

用 `cockpit app install` 就没有这一步：Node 写下的文件不带"来自网络"的标记，校验和代替了签名的作用。

### 自己构建

在源码目录里：

```bash
npm run desktop:build                    # 产物在 desktop/dist/
cockpit app install --from desktop/dist  # 安装这份构建
```

`npm run install:local` 会一次性从源码构建并安装 Cockpit 和 App。

## 打开 App 时发生了什么

1. App 读取登录 shell 的环境（macOS）或注册表里的 `PATH`（Windows），像终端一样找到 `node`、`npm` 和 `cockpit`。Cockpit 启动的 agent 和终端也继承这份环境。
2. 找不到 `cockpit` 时，它会提出帮你执行 `npm install -g @surething/cockpit`。没有 Node 或版本低于 22.19 时，它会给出 Node.js 下载页的链接。
3. 如果你的数据目录（`~/.cockpit` 或 `COCKPIT_HOME`）还没有服务在跑，它会执行 `cockpit start`，和在终端里启动的后台服务完全一样。
4. 在窗口里加载 `http://localhost:<端口>`。

同一个服务上的浏览器标签页可以和 App 同时使用。App 只连接本机的 Cockpit；远端服务器上的 Cockpit 请用浏览器访问（见[服务端部署](/zh/docs/get-started/server-deployment/)）。

## 关闭和退出

关掉窗口或退出 App，服务都会继续在后台运行，和 `cockpit start` 一样。要停止服务，用 App 的**服务**菜单（**停止…**）或执行 `cockpit stop`。停止服务会同时结束正在运行的终端和 agent。

**服务**菜单里还有**重启**、**在浏览器中打开**和**打开日志目录**。

## 外观

窗口使用系统原生标题栏，深浅色跟随 Cockpit 自己的**设置 → 主题**（跟随系统 / 浅色 / 深色），而不只是跟随系统设置。

## 更新

更新 Cockpit（`cockpit update`，或点侧边栏的版本号）不需要更新 App。App 只是一个很少变动的壳：每个 Cockpit 版本都记录了它对应哪一份壳，只有和 App 自己的不一样时，App 才会提示更新。

需要更新时：

1. 你会收到一条通知，App 菜单里出现**下载更新（版本号）…**（Windows 在**帮助**菜单里）。
2. 在后台下载，期间照常使用。
3. 点**重启以更新**，或者直接退出 App，退出时会换成新版。

不经你同意不会下载。在同一个菜单里勾选**自动下载更新**可以省去确认。手动执行 `cockpit app update` 效果相同。

## 卸载

```bash
cockpit app uninstall
```

这会删除 App（Windows 上连同开始菜单快捷方式）。`~/.cockpit` 里的项目、会话和设置都不受影响，Cockpit 本身也还在。

## 常见问题

**终端里能用 `cockpit`，App 却说"还没有安装 OpenCockpit"**

App 在登录 shell 的 `PATH` 里找 `cockpit`。如果 shell 配置启动时报错，或者启动超过十秒，App 会退回到最小的 `PATH`。检查 `$SHELL -ilc 'command -v cockpit'` 能不能输出路径。

**服务没有启动成功**

App 会显示 `cockpit start` 的最后几行输出。点**打开日志目录**查看 `server.log`，或者在终端里执行 `cockpit start` 看完整报错。

**`cockpit app install` 提示没有桌面 App 的校验和**

你的 Cockpit 来自源码目录，或者版本早于 1.1.6。更新 Cockpit，或者自己构建 App 后用 `--from` 安装。

**macOS 提示 App"已损坏，无法打开"**

下载的文件被 Gatekeeper 拦截了。按[手动下载](#手动下载)里的方法去掉隔离标记，或者用 `cockpit app install` 重新安装。
