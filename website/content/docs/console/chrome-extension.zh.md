OpenCockpit Bridge 扩展让 [`cockpit browser`](/zh/docs/reference/cli/#cockpit-browser)（以及对话里的 AI）能操作你真实的 Chrome：你允许的标签页（用的是你自己的登录状态），以及 Console 气泡里的本地 HTML 应用和文件预览。

它是可选的。Agent、Explorer、终端、数据库气泡都不依赖它；只有需要在浏览器页面里动手时才用得上。

| 章节 | 内容 |
|---|---|
| [功能介绍](#功能介绍) | 命令怎么到达浏览器，AI 在标签页里能做什么 |
| [安装](#安装) | 3 分钟装好、两个要检查的 Chrome 设置、升级后怎么生效 |
| [使用](#使用) | 按标签页授权、工具栏小面板、顶部的调试提示条 |
| [权限说明](#权限说明) | Chrome 申请的权限、为什么需要、信任模型 |

## 功能介绍

### 命令怎么到达 Chrome

```text
cockpit browser … ──▶ Cockpit 服务 ──▶ 本地桥接程序 ──▶ 扩展 ──▶ 你的标签页
                      （每次启动换新 token） （bin/bridge-host.mjs）
```

- Cockpit 每次启动都会给本机找到的每个 Chromium 系浏览器（Chrome、Edge、Brave、Vivaldi、Arc、Opera、Chromium）注册一个 **native messaging 本地程序**，macOS、Linux、Windows 都支持，不需要你额外安装什么。
- 本地程序会连上所有正在运行的 Cockpit 实例（prod 和 dev 都算），用的 token 每次服务启动都会更换。
- 扩展**只**接受这个本地程序发来的命令。任何网页（包括 Cockpit 自己的界面）都无法给它发命令。它不改请求头、不注入 cookie、不伪装页面，网站的运行方式和没装它时完全一样。

### AI 在标签页里能做什么

人坐在电脑前能做的，它基本都能做：

- **读页面**：无障碍树快照，包括跨域 iframe 和 shadow DOM；还能用 `evaluate` 执行 JavaScript。
- **用真实输入操作**：点击、输入、按键、悬停、滚动、拖放、长按都走 Chrome 自己的输入通道，页面收到的是可信事件。
- **处理通常会卡住自动化的东西**：`alert` / `confirm` / `prompt` 弹窗，以及文件上传（不会弹出系统文件选择框）。
- **排查问题**：控制台消息、带请求/响应正文的网络请求、事件监听器、性能指标、CSS 覆盖率，以及整页或单个元素的截图。
- **模拟测试环境**：手机/平板视口（含触屏）、深色模式、断网或弱网、CPU 降速、屏蔽指定请求、打印样式。

网页一律在**真实的 Chrome 标签页**里打开（归在 **Cockpit** 分组下），所以带着你的登录状态，也不会遇到「拒绝被嵌入」。Console 气泡只用于 Cockpit 自己提供的内容：本地 HTML 应用和文件预览。

## 安装

安装或升级 Cockpit 时，扩展文件会复制到 `~/.cockpit/chrome-extension/`，只需要在 Chrome 里指向它一次。

### 一步步

#### 1. 复制路径

在 Cockpit 里打开 **设置 → 浏览器插件**，点 **复制插件目录路径**。

#### 2. 打开扩展程序页

在 Chrome 地址栏打开 `chrome://extensions`（Edge、Brave 等同理）。

#### 3. 打开开发者模式

右上角的开关。从文件夹加载扩展需要它，不影响其他东西。

#### 4. 加载已解压的扩展程序

点 **加载已解压的扩展程序**，选第 1 步复制的文件夹。列表里出现 **OpenCockpit Bridge** 卡片即可。

#### 5. 检查卡片上的两个设置

点卡片上的 **详情**：

- **网站访问权限** 必须是 **在所有网站上**。Cockpit 能操作哪些标签页仍然由你逐个决定（见 [使用](#使用)）；没有这个权限，Chrome 会悄悄阻止扩展在页面里运行。如果权限被收回，工具栏小面板里会出现 **Grant access to all sites** 按钮。
- **允许访问文件网址**：想让 AI 往网页里**上传文件**就打开它，其他功能不需要。

### 确认

**设置 → 浏览器插件** 里显示 **OpenCockpit Bridge 已连接**。也可以运行：

```bash
cockpit browser tabs
```

会列出你打开的标签页和它们的 id。

### 升级后

`cockpit update` 会更新 `~/.cockpit/chrome-extension/` 里的文件，但 **Chrome 在扩展重新加载之前会一直运行旧代码**：

- **设置 → 浏览器插件 → 重载插件**，或者
- 在 `chrome://extensions` 里点 **OpenCockpit Bridge** 卡片上的刷新图标。

### 移除

`chrome://extensions` → **OpenCockpit Bridge** → **移除**。

### 常见问题

- **显示「OpenCockpit Bridge 未连接」**：Cockpit 需要在运行（它启动时注册本地程序）。如果是在 Cockpit 启动之后才装的新浏览器，重启一次 Cockpit。
- **命令卡住，或提示网站访问权限**：把 **网站访问权限** 设为 **在所有网站上**（第 5 步）。
- **上传失败，提示 "Allow access to file URLs"**：打开那个开关（第 5 步）。
- **升级后行为没变**：重新加载扩展（见 [升级后](#升级后)）。

## 使用

### 每个标签页都有 id

每个标签页都有一个固定的短 id，例如 `qmmm`。在工具栏小面板里能看到（**Copy** 按钮会复制 `cockpit browser qmmm`），鼠标悬停在图标上也能看到，或者运行 `cockpit browser tabs`。把它交给 AI，AI 就能操作这个标签页。

### 按标签页授权

- **Cockpit 打开的标签页**（比如在 Console 输入栏里输入网址，或 `cockpit browser open <url>`）自动允许。
- **其他标签页**（你自己的）默认不允许。第一次对它发命令时，那个标签页会被切到前台，并在工具栏小面板里询问 **Allow this tab** / **Deny**。允许一个标签页不会连带允许别的，同一网站的也不会。
- 小面板里的 **Stop**，或 `cockpit browser <id> release`，会收回授权，下次再操作时重新询问。
- `close` 只会关掉 Cockpit 打开的标签页，不会关你的。

### 工具栏图标

| 图标 | 含义 |
|---|---|
| 灰色 | Cockpit 操作这个标签页前会先问你 |
| 绿点 | Cockpit 可以操作这个标签页 |
| 橙点 | Cockpit 正在操作这个标签页 |
| **?** 标记 | Cockpit 在请求授权，点图标回答 |

### 小面板

点图标会看到：

- **Cockpit is driving now**：调试器正连着的标签页和原因（例如 *console & network capture, 2 min left · iPhone 15 viewport*）。点整行切到那个标签页；**Stop** 立即断开，并撤销各种模拟设置。
- **This tab**：当前标签页的 id、**Copy**、**Allow** / **Stop**。
- **Other tabs Cockpit may control**：点击切过去，**Stop** 收回授权。

### 「OpenCockpit Bridge 已开始调试此浏览器」

只要扩展的调试器连着**任意一个**标签页，Chrome 就会在**所有**标签页顶部显示这条提示。扩展改不了它的文字，也没法只在一个标签页上显示；要知道是哪个标签页，看小面板或橙色图标。

调试器会在最后一条命令后几秒钟断开，以下情况除外：

- 控制台/网络抓取：AI 最后一次读取后 2 分钟结束；
- 视口、深色模式或 `emulate` 设置：直到被重置；
- 有弹窗在等待回答。

点小面板里的 **Stop** 或提示条上的 **取消** 会立刻结束，页面也会恢复正常尺寸。

## 权限说明

| 权限 | 用途 |
|---|---|
| **`nativeMessaging`** | 命令的唯一来源：Cockpit 注册的本地程序。 |
| **`debugger`** | 真实输入、弹窗、上传、截图、模拟、控制台/网络抓取（Chrome DevTools Protocol）。只在工作时连接，这时 Chrome 会显示调试提示条。 |
| **`scripting`** | 在被操作的标签页或气泡里运行读取页面的代码（快照、查找元素）。 |
| **`tabs`**、**`tabGroups`** | 列出标签页和 id，打开/显示/关闭 Cockpit 打开的标签页，并把它们放进 **Cockpit** 分组。 |
| **`webNavigation`** | 找到页面里的各个框架（iframe、Console 气泡）。 |
| **`storage`** | 记住标签页 id 和你允许过的标签页，浏览器重启后依然有效。 |
| **`alarms`** | 本地程序重启后自动重连。 |
| **`clipboardWrite`** | 小面板里的 **Copy** 按钮。 |
| **`host_permissions: <all_urls>`** | Chrome 要求有它才能在你允许的页面里运行。Cockpit 实际操作哪些标签页，由你逐个决定。 |

扩展还有一段内容脚本会在每个框架里加载，但除非这个框架是 Cockpit 的 Console 气泡（名为 `cockpit-bubble-…`，位于本地 Cockpit 页面内、且与它同源），否则什么都不做；在气泡里它负责记录控制台和网络活动，供 `cockpit browser` 读取。

### 扩展**不做**什么

- 不接受网页发来的命令，只接受本地程序的；本地程序也只转发持有当前 token 的 Cockpit 服务的命令。
- 不操作你没允许（也不是 Cockpit 打开）的标签页。
- 不改写请求或响应，不注入 cookie，也不读取你的 cookie。
- 不往任何地方发送浏览数据：没有遥测，没有更新服务器，只随 Cockpit 一起更新。

### 信任模型

扩展以「你自己加载的代码」的形式提供，方便你审查：它就是 Cockpit 包里的 `chrome-extension/` 目录，信任模型写在 `chrome-extension/background.js` 的开头。

有一点要说清楚：一旦你允许了某个标签页，AI 就是**带着你的登录状态**在里面操作。像把键盘交给别人一样谨慎地允许标签页，用完记得点 **Stop**。
