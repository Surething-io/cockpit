# Cockpit - Chat Demo Project

## Development

- **Dev Server Port**: 3456 (run `npm run dev`)
- **Tech Stack**: Next.js 16, React, TypeScript, TailwindCSS

## UI 布局

- **三屏滑动模式**: 通过 `SwipeableViewContainer`（translateX）实现三屏并排，左右滑动切换：
  - 第一屏 **Agent**（Chat 对话）
  - 第二屏 **Explorer**（文件浏览）
  - 第三屏 **Console**（终端 + 浏览器气泡）
- **三屏始终同时渲染**，切屏只是 CSS transform 平移，不会卸载/重新挂载组件
- **UI 组件注意事项**: 在做菜单、Modal 对话框和悬浮气泡时，需要注意三屏布局的影响：
  - 定位计算需考虑所在屏幕的边界
  - z-index 层级需统一管理
  - 避免组件溢出到另一屏

## Project Structure

- `/src/app` - Next.js App Router pages and API routes
- `/src/components` - React components
  - `FileBrowserModal.tsx` - Unified file browser with 4 tabs (目录树, 最近浏览, Git 变更, Git 历史)
  - `TabManager.tsx` - Main tab manager component
  - `Chat.tsx` - Chat interface component
  - `ChatInput.tsx` - Chat input component
  - `console/BrowserBubble.tsx` - 浏览器气泡组件（iframe + automation bridge）
- `/src/lib/browser` - Browser automation 服务端逻辑
  - `BrowserBridge.ts` - shortId 注册表 + pending request 管理
- `/src/hooks/useBrowserBridge.ts` - BrowserBubble 的 WS bridge hook
- `/chrome-extension` - Chrome 插件（Manifest V3）
  - `content.js` - 内容脚本（iframe 内激活）
  - `automation.js` - 自动化层（a11y tree、DOM 操作、console/network 拦截）
  - `background.js` - Service Worker（Cookie 注入、截图）
- `/bin` - CLI 入口
  - `cock.mjs` - 主入口（启动 server，子命令分流，--help/--version）
  - `cock-browser.mjs` - `cock browser` 子命令
  - `cock-terminal.mjs` - `cock terminal` 子命令
  - `postinstall.mjs` - 安装后修复 node-pty 权限（macOS）

## Key Features

- File browser with virtual scrolling and syntax highlighting (Shiki)
- Git status and history integration
- Git blame view
- Code search with Cmd+F (case sensitive / whole word matching)
- ESC key exits blame view first, then closes modal (3s debounce)

## Commands

```bash
npm run dev      # Start dev server on port 3456
npm run build    # Build for production
npm run setup    # Build + npm link
npm run lint     # Run ESLint
cock             # Start production server (port 3457)
cock -v          # Show version
```

## 项目特性

- **纯本地应用**: 所有 API 请求延迟在 10ms 内
- **不需要接口缓存**: 本地请求足够快，缓存带来的性能收益可忽略，反而会引入数据一致性问题

## Claude Code 使用规范

- **浏览器测试**: 使用 `evaluate_script` 操作 DOM，避免使用 `take_screenshot`（消耗大量 token）
- **非必要不截图**: 只在需要视觉确认时才截图
- **MCP 工具**: 非必要不使用 MCP 工具，除非用户消息明确要求（如 "use xxx"）
- **Git 提交**: 不要自动 commit 代码，需要用户明确说 "commit" 才提交
