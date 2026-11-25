OpenCockpit 里有两种浏览器目标，AI 都能用 [`cockpit browser`](/zh/docs/reference/cli/#cockpit-browser) 来操作：

- **网页在真实的 Chrome 标签页里打开**：带着你的登录状态，归在 **Cockpit** 标签页分组里。不会被拒绝加载，也不再嵌入到 Cockpit 页面中。
- **Console 里的浏览器气泡** 只显示 **Cockpit 自己提供的内容**：本地 HTML 应用和文件预览（Markdown、JSON、CSV、图片、PDF 等）。

要让 AI 操作它们，都需要安装 [OpenCockpit Bridge 扩展](/zh/docs/console/chrome-extension/#安装)。

## 打开网页

在 Console 输入栏输入任意网址：

```text
https://example.com
```

页面会在 **Cockpit** 分组里以新的 Chrome 标签页打开，Chrome 会切到前台，同时弹出一条提示，给出这个标签页的命令，例如 `cockpit browser qmmm`。Cockpit 打开的标签页直接允许 AI 操作。

如果扩展没有连接，网址会在普通的新浏览器标签页里打开，AI 无法操作它。

> 旧版本里以浏览器气泡打开的网页，现在会显示「网页现在在 Chrome 标签页中打开，不再放在 Console 里。」和一个 **在 Chrome 中打开** 按钮。

## 把标签页交给 AI

先自己把页面操作到需要的状态（登录、打开对应的页面），然后把标签页的 id 交给 AI。id 可以从这些地方拿到：

- Cockpit 打开标签页时弹出的提示；
- 扩展的工具栏小面板（**Copy** 会复制 `cockpit browser <id>`）；
- `cockpit browser tabs`，列出所有标签页和 id。

粘贴到 **Agent** 面板，说明要做什么：

```text
标签页 `cockpit browser qmmm` 是我们的管理后台。
我点「刷新指标」时帮我抓一下网络请求，看看为什么要 4 秒。
```

AI 就能读取页面、用真实输入点击和输入、抓取控制台和网络、处理弹窗、上传文件、截图、模拟手机等等，完整命令见 [CLI 参考](/zh/docs/reference/cli/#cockpit-browser)。

**你自己**打开的标签页也可以，但第一次对它发命令时会先问你：那个标签页切到前台，扩展小面板里出现 **Allow this tab** / **Deny**。授权按标签页逐个生效，小面板里的 **Stop**（或 `cockpit browser <id> release`）会收回授权。详见 [扩展的使用](/zh/docs/console/chrome-extension/#使用)。

## 浏览器气泡：本地 HTML 和文件

运行 `cockpit browser open ./report.html`（或任意文件路径）会在该文件所属项目的 Console 里打开一个浏览器气泡。最大化（`Cmd+M`）后，头部从左到右是：

- **🌐 短 ID 徽标**：复制 `cockpit browser <id>`（dev 环境是 `cockpit-dev browser <id>`）。
- **🔄 加载动画**：页面加载时显示。
- **当前 URL**：可编辑，回车跳转。
- **📋 复制 URL**：复制当前地址。
- **↻ 刷新**：重新加载页面。
- **↗ 在新窗口打开**：在新的浏览器窗口里打开当前地址。
- **✕ 退出最大化**：也可以按 `Esc`。

> 未最大化时，气泡缩成缩略图，头部也更窄。

预览本地 `.html` 就等于**运行它**，权限和任何 [HTML 应用](/zh/docs/agent/html-apps/) 一样，只预览你信任的文件。

### 气泡生命周期

- **多个气泡**：想开几个开几个，可以拖动排序。
- **休眠**：气泡 5 分钟没出现在屏幕上、且没有被 AI 注册使用时，会卸载以节省内存，状态栏显示「已休眠」，点一下唤醒。对它执行 `cockpit browser <id>` 命令也会自动唤醒，前提是它所属的项目在某个 Cockpit 窗口里开着。
- **加载失败**：气泡显示错误和 **重试** 按钮。
- **关闭**：移除气泡；再次打开同一文件会重新加载。

## 常见问题

- **「OpenCockpit Bridge 未连接」**：安装或重新加载 [扩展](/zh/docs/console/chrome-extension/#安装)，并确认 Cockpit 在运行。
- **命令停在 "Waiting for the user to allow control"**：这是你自己的标签页，在扩展小面板里回答（图标上显示 **?**）。
- **Chrome 提示「已开始调试此浏览器」**：AI 操作标签页时的正常现象，见 [调试提示条](/zh/docs/console/chrome-extension/#使用)。
- **`cockpit browser open <文件>` 以退出码 2 结束**：没有任何 Cockpit 窗口打开了那个项目；打开项目（或检查 `--cwd`）后重试。

## 下一步

- [Chrome 扩展](/zh/docs/console/chrome-extension/#功能介绍)：它怎么工作、能做什么
- [CLI 参考 → cockpit browser](/zh/docs/reference/cli/#cockpit-browser)：全部命令
