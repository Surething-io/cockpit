Cockpit 的 Chrome 扩展是可选的。Cockpit 的大部分能力 —— Agent、Explorer、终端 / 数据库 / Jupyter 气泡 —— 不装也能跑。只有当你想让**浏览器气泡**像真实 Chrome 标签页那样工作(而不是普通 iframe)时才需要它。

如果你在浏览器气泡里碰到 CORS 报错、登录 cookie 丢失、"此网站拒绝在 iframe 中嵌入" 这类问题,扩展就是答案。

| 章节 | 内容 |
|---|---|
| [功能介绍](#功能介绍) | 扩展给浏览器气泡解锁的 4 项能力 |
| [安装与自动重载](#安装与自动重载) | 3 分钟搞定,以及升级时的自动重载机制 |
| [权限说明](#权限说明) | Chrome 申请的权限、为什么需要,以及隐私边界 |

## 功能介绍

Cockpit 自带一个可选的 Chrome 扩展。Cockpit 大部分功能不需要它 —— Agent、Explorer、数据库 / 终端气泡没扩展也能用。只有想让**浏览器气泡**表现得像真正的 Chrome 标签页（而不是 iframe）时才需要。

如果你在浏览器气泡里跟 CORS 错误、登录 cookie 问题、"这个网站拒绝被嵌入"消息斗争，装扩展就是答案。

### 它加什么

扩展做四件事，全部局限在 Cockpit 的浏览器气泡上：

#### 1. 复用你真实 Chrome 的 cookie

不装扩展时，Cockpit 里的 iframe 不跟你 Chrome 的其它部分共享 cookie —— 所以你在正常浏览器里登录的网站，气泡看到的是未登录态。扩展在每次请求前注入对的 cookie，让气泡看起来跟你主浏览器 tab 一样是登录态。

#### 2. 拦截链接点击

`target="_blank"` 链接正常会在 Chrome 开新 tab、失去跟 Cockpit 的连接。扩展抓这些点击路由回 Cockpit —— 视情况更新当前浏览器气泡的 URL 或开新气泡。这让 AI 驱动的工作流跨页面跳转都不断。

#### 3. 抓完整网络请求 body

[`cockpit browser`](/zh/docs/reference/cli/#cockpit-browser) 的 `network` 和 `network_record` action 能返回 request / response body —— 但只有装了扩展才行。不装的话只有 URL 和状态信息，没 body。

#### 4. 启用页面内 JavaScript 执行

`evaluate` action 在页面上下文里跑 JavaScript。不装扩展时受 iframe 沙箱限制；装了之后，你能跑任何 Chrome DevTools 控制台能跑的东西。

### 不装扩展时

你仍能：

- 加载任何不拒绝 iframe 的页面（多数公开站、`localhost`）。
- 点击、滚动、看内容。
- 截图（分辨率受限）。
- 获取 URL、标题、最小元素信息。

你不能：

- 在你正常 Chrome 里用过的站保持登录。
- 让本来会开新 tab 的链接继续工作。
- 在网络抓取里看 request / response body。
- 跑有完整页面访问权限的任意 JavaScript。

### 隐私

扩展只在 Cockpit 显式告诉它的 tab 上激活（用一个隐藏的 `_cockpit=1` URL 参数追踪）。它不读、不干扰你在 Chrome 里做的任何其它浏览。

完整权限列表和原因见 [权限](#权限说明)。

## 安装与自动重载

装 Cockpit Chrome 扩展大约 3 分钟。扩展文件在你装 Cockpit 时已经复制到了 Cockpit 数据目录 —— 你只是要告诉 Chrome 这件事。

### 一步步

#### 1. 拿到扩展路径

在 Cockpit 里打开**设置**。找到 **Chrome 扩展** 区块。点 **复制扩展路径**。

会把类似 `~/.cockpit/chrome-extension/`（完整绝对路径）放到你剪贴板。

#### 2. 打开 Chrome 扩展页

在 Chrome 里访问 `chrome://extensions`。

#### 3. 打开开发者模式

扩展页右上角有个 **开发者模式** 开关。打开。要加载未打包扩展必须开这个；它不影响别的。

#### 4. 加载已解压的扩展程序

开发者模式打开后会出现 3 个按钮：**加载已解压的扩展程序**、**打包扩展程序**、**更新**。点 **加载已解压的扩展程序**。

文件选择器打开。粘贴第 1 步复制的路径，按 Open / Select。

完事。扩展卡片出现在你的扩展列表里。**卡片标题是 "OpenCockpit Bridge"**(`manifest.json` 里的 `name` 字段),带版本号。

### 确认

切回 Cockpit，刷新页面。在**设置 → Chrome 扩展**，指示器变**绿**，旁边带扩展版本号。

之后打开浏览器气泡时，URL 栏会有个小标记表示气泡现在被扩展驱动。

### 升级与重载

`cockpit update` 升级 Cockpit 时,`~/.cockpit/chrome-extension/` 里的扩展文件会被刷新。**Chrome 不会自动捡起这些文件改动** —— Chrome 扩展默认没有这个机制。要让新版生效:

1. 打开 Cockpit **设置 → Chrome 扩展**。装好扩展后会出现 **Reload 扩展** 按钮 —— 点它。
2. 或者 `chrome://extensions` 里手动点 **Cockpit** 卡片的刷新按钮。

不用在 Chrome 里重装,**只是重载**。刷新已经开的浏览器气泡才能用上新版扩展。

### 移除扩展

要移除：

1. Chrome 里访问 `chrome://extensions`。
2. 找到 Cockpit 卡片。
3. 点 **Remove**。

Cockpit 设置里的指示器下次页面加载时变回灰色。

### 常见问题

- **Chrome 里 "Failed to load"** —— 你粘的路径不指向文件夹。从设置里再复制一次，准确粘贴。
- **扩展加载了但 Cockpit 设置仍显示 "未安装"** —— 在浏览器里刷新 Cockpit 页面。
- **刷新后指示器还是灰** —— 扩展装在了跟 Cockpit 打开的不同的 Chrome profile 里。换 profile 或两边都装。

## 权限说明

你加载 Cockpit Chrome 扩展时，Chrome 会显示一份权限列表。这一页解释每项权限干什么用，方便你决定是否能接受。

### 权限

| 权限 | Cockpit 为什么需要它 |
|---|---|
| **`storage`** | 存扩展自己的设置（连哪个 Cockpit 实例等）—— 小、本地、不碰你的浏览数据。 |
| **`cookies`** | 读你在 Cockpit 浏览器气泡里访问的网站的 cookie，气泡请求同站时注入。这就是"保持登录"在底层的样子。 |
| **`declarativeNetRequest`** | 通过 Chrome 网络规则层把上面的 cookie 注入到出站请求。每条规则限定在特定 Cockpit tab 上 —— 不影响浏览器其它部分。 |
| **`webNavigation`** | 追踪 Cockpit 标记的 iframe 何时导航，让扩展知道哪个气泡对应哪个 Chrome frame。 |
| **`tabs`** | 识别哪个 Chrome tab 是 Cockpit tab，让扩展把工作限定在那。 |
| **`scripting`** | 注入小的 content script 处理浏览器气泡里的链接拦截和 JavaScript 执行。 |
| **`webRequest`** | 观察 Chrome 最终发出的 header，用于调试上面 cookie 注入的正确性。只读 —— 不改请求。 |
| **`host_permissions: <all_urls>`** | 扩展要能在你浏览器气泡里加载的任何 URL 上工作。因为你能加载任意 URL，扩展技术上得允许在所有 URL 上。 |
| **`externally_connectable: localhost / 127.0.0.1`** | 让运行在 `http://localhost:*` 或 `http://127.0.0.1:*` 上的 Cockpit web app 直接给扩展发消息 —— 用于快速、有序的 cookie 注入，跨页面导航也有效。 |
| **`web_accessible_resources`** | 暴露 `disguise.js` / `automation.js` / `network-capture.js` 给 Cockpit 页面注入到浏览器气泡里 —— 实现伪装真实 tab、自动化 action、网络抓取的实际代码。 |
| **`declarative_net_request` rule_resources** | 内置 DNR 规则集，其中一条规则把请求 URL 里的 `_cockpit=1` 标记在发出前剥掉，避免外部服务器看到。 |

### 隐私边界

扩展被设计成**只在 Cockpit 用的 tab 上**做事。机制：Cockpit 给浏览器气泡里加载的每个 URL 加一个隐藏的 `_cockpit=1` 参数。扩展只在顶级 URL 带这个标记的 tab / iframe 上启用功能。

所以虽然权限说"所有 URL"（技术上必需，因为你可能让 Cockpit 加载任意站），但被 `_cockpit=1` 标记 gate 住：

- 你正常的 Chrome 浏览 tab → 扩展什么都不做。
- 其它扩展的 iframe → 扩展什么都不做。
- Cockpit 标记的 iframe → 扩展启用 cookie 注入、链接拦截、JS 执行。

### 扩展**不做**什么

明确一下，即使有这么宽的权限，扩展**不**：

- 读或发送任何浏览数据到任何服务器。
- 修改你在 Cockpit 外访问的页面。
- 给 Cockpit 标记 frame 之外的请求注入 cookie。
- 记录键盘、鼠标移动、或被动收集任何东西。
- "回家" —— 没有遥测、没有分析、没有自动更新服务器（只通过你的 `cockpit update` 更新）。

完整扩展源码在 Cockpit npm 包的 `chrome-extension/` 下 —— 你在意安全可以自己读。

### 信任模型

扩展不发布到 Chrome 应用商店、**作为你自己加载的代码**发出来，正是为了让你能审计。你信任的是 Cockpit 这个工具，不是第三方发布者。每次安装就是你 `~/.cockpit/chrome-extension/` 文件夹里的内容。
