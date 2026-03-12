# Cockpit

One seat. One AI. Everything under control.

## Install

```bash
cd /path/to/cockpit
npm install && npm link
```

## Quick Start

```bash
cock            # Start server on http://localhost:3457
cock -h         # Show help
cock -v         # Show version
```

## Chrome Extension

首次安装后需手动加载一次：

1. Chrome 打开 `chrome://extensions/`
2. 开启右上角「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择源代码目录下的 `chrome-extension/` 文件夹

源代码更新后插件自动生效，无需重复操作。也可在 Cockpit 设置页查看插件状态和路径。

## Browser Automation

AI Agent 通过 CLI 控制 console 中已打开的浏览器气泡。

**使用流程：**
1. 启动 Cockpit（`cock`）
2. 在 console 中输入 URL 打开一个网页
3. 气泡标题栏出现 4 位短 ID 徽标（如 `abcd`），点击复制命令
4. 在终端执行命令

**常用命令：**
```bash
cock browser list                          # 列出所有已连接的浏览器
cock browser abcd snapshot                 # 获取 a11y tree（页面结构）
cock browser abcd screenshot               # 截图
cock browser abcd navigate --url URL       # 导航
cock browser abcd click --ref e5           # 点击元素
cock browser abcd type --ref e3 --text "hello"  # 输入文字
cock browser abcd fill --ref e3 --value "hello"  # 填充表单
cock browser abcd evaluate --js "return document.title"  # 执行 JS
cock browser abcd url                      # 获取当前 URL
cock browser abcd title                    # 获取页面标题
cock browser abcd console --level error    # 查看 console 错误
cock browser abcd network --status 4xx,5xx # 查看失败的请求
cock browser abcd wait --text "Dashboard"  # 等待文本出现
cock browser abcd assert --ref e5 --visible true  # 断言元素可见
cock browser abcd perf --metric timing     # 页面加载性能
cock browser abcd computed --ref e5        # 查看计算样式
cock browser abcd bounds --ref e5          # 查看元素尺寸位置
cock browser abcd theme --mode dark        # 切换深色模式
cock browser abcd --help                   # 查看完整命令列表
```

**数据流：** `CLI → HTTP API → WebSocket → BrowserBubble → postMessage → iframe content script → 结果原路返回`

## Terminal Automation

```bash
cock terminal list                         # 列出所有运行中的终端
cock terminal abcd output                  # 读取终端输出
cock terminal abcd stdin "ls -la"          # 发送命令
cock terminal abcd follow                  # 实时流式输出（Ctrl+C 退出）
cock terminal abcd --help                  # 查看完整命令列表
```

## Development

```bash
npm run dev         # Start dev server (port 3456, HMR)
npm run build       # Build for production
npm run setup       # Build + npm link
npm run lint        # Run ESLint
```

开发时子命令连接 dev server：
```bash
cock-dev browser abcd snapshot
cock-dev terminal abcd output
```
