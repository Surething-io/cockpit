# Cockpit

One seat. One AI. Everything under control.

## Getting Started

### Development

```bash
npm run dev
```

Opens at [http://localhost:3456](http://localhost:3456) with dev icon (orange star badge).

### Production

```bash
npm run build && npm run start
```

Opens at [http://localhost:3457](http://localhost:3457) with production icon.

## Commands

| Command | Description |
|---------|-------------|
| `npm run dev` | Start dev server (port 3456) |
| `npm run build` | Build for production |
| `npm run start` | Start production server (port 3457) |
| `npm run lint` | Run ESLint |
| `npm run generate-icons` | Regenerate PWA icons |

## CLI 安装

```bash
# 在项目根目录执行，全局注册 cock 命令
npm link
```

安装后可用：
- `cock` — 构建并启动生产服务器（port 3457）
- `cock-dev` — 构建并启动开发服务器（port 3456）
- `cock browser <id> <action>` — 控制浏览器气泡（连接 prod 3457）
- `cock-dev browser <id> <action>` — 控制浏览器气泡（连接 dev 3456）

## Chrome 插件

路径：`/chrome-extension/`

**安装步骤：**
1. Chrome 打开 `chrome://extensions/`
2. 开启「开发者模式」
3. 点击「加载已解压的扩展程序」，选择项目下的 `chrome-extension/` 目录
4. 插件会自动检测代码更新并重载

## Browser Automation

AI Agent 通过 CLI 控制 console 中已打开的浏览器气泡。

**使用流程：**
1. 启动 dev server（`npm run dev`）
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
