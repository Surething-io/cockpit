浏览器气泡从 Cockpit 的 Console 面板里驱动一个真实的 Chrome 标签页。指向一个 URL,页面就加载出来,然后能导航、点击、输入、截图、抓网络流量,最关键的 —— **把整个标签页交给 AI 替你操作**。

打开方式:在 Console 输入栏打任意 URL:

```text
https://example.com
```

## 头部控制(最大化时)

气泡里嵌入实时页面。最大化(`Cmd+M`)后头部从左到右:

- **🌐 短 ID 徽章** —— 点击注册气泡为 CLI 可控,并把 `cock browser <id>`(开发模式下是 `cockpit-dev browser <id>`)复制到剪贴板。粘到 Agent 面板里 AI 就能驱动这个标签页。
- **🔄 加载状态** —— 页面加载中转圈。
- **当前 URL** —— 可以直接编辑、回车导航。
- **📋 复制 URL** —— 当前 URL 复制到剪贴板。
- **↻ 刷新** —— 重载当前页。
- **↗ 在新窗口打开** —— 在你的系统浏览器里打开当前 URL。
- **✕ 退出最大化** —— `Esc` 也可以。

> 非最大化时气泡缩成略缩图(`scale(0.5)`),控制按钮也在头部精简显示。

## 装不装 Chrome 扩展的区别

浏览器气泡**不装** Cockpit Chrome 扩展也能用 —— 就是在 iframe 里显示页面。`localhost` 站点和多数公开页够用了。

装了 **[Cockpit Chrome 扩展](/zh/docs/console/chrome-extension/#功能介绍)** 后:

- 复用你真实 Chrome 的 cookie(扩展通过 `chrome.runtime.sendMessage` 在 iframe 加载前预注入 cookie,2 秒超时)。
- 拦截 iframe 内的链接点击(`cockpit:new-tab` / `cockpit:navigate` 消息),"在新标签页打开"配合 Cockpit 工作而不是甩出独立窗口。
- 抓网络请求,带完整 request / response body。

跟 CORS、登录跳转、"不能在 iframe 加载"这些错误较劲时,装扩展通常就解决了。气泡里没有"扩展已连接"标牌 —— 它是否在线由内部 bridge 状态隐式驱动(影响下面的休眠行为)。

## 把标签页交给 AI

杀手特性。自己先把页面导航到对的状态 —— 登录、点对的 tab、填好上下文 —— 然后:

1. 点头部短 ID 徽章,`cock browser <id>` 自动到剪贴板。
2. 切到 **Agent** 面板,粘贴 + 你要 AI 做什么:

```text
气泡 `cock browser xa7k2` 是我们的 admin 仪表盘。
我点"刷新指标"时抓一下网络请求,告诉我为什么要 4 秒。
```

AI 现在能跑 `cock browser xa7k2 …` 命令检查和驱动页面 —— 读 DOM、抓网络、执行 JavaScript、截图、点击、输入。

完整 action 列表见 [CLI 参考:cockpit browser](/zh/docs/reference/cli/#cockpit-browser)。

## 气泡生命周期

- **多气泡** —— 想开几个浏览器气泡都行,各自一个 URL。
- **拖动重排** —— 跟其它气泡一样。
- **休眠** —— 浏览器气泡若 5 分钟未出现在视口里(`IntersectionObserver` 跟踪)且**没有被 AI bridge 接管**,Cockpit 卸载它的 iframe 省内存;状态栏显示黄色 "sleeping" 标记。点"唤醒"按钮重新加载页面 —— URL 保留。
- **加载失败** —— iframe 加载错就显示错误信息 + **重试**按钮。
- **关闭** —— 气泡从面板里移除;再下次打开同 URL 会重新走一遍加载流程。

## 常见问题

- **页面加载不出 / 空白** —— 最常见是网站拒绝被 iframe 嵌入(CSP `frame-ancestors` 或 `X-Frame-Options`)。装 [Chrome 扩展](/zh/docs/console/chrome-extension/#安装与自动重载)一般就好。
- **登录过期** —— 不装扩展时 iframe 不跟你正常 Chrome 共享 cookie。要么在 iframe 里再登录,要么装扩展。
- **AI 驱动不了气泡** —— 确认先点了短 ID 徽章;气泡得注册过 `cock browser <id>` 才能找到它。

## 下一步

- [Chrome 扩展](/zh/docs/console/chrome-extension/#功能介绍) —— 它能加什么
- [CLI 参考 → cockpit browser](/zh/docs/reference/cli/#cockpit-browser) —— AI 用 `cock browser <id>` 能做什么
