# Cockpit - Chat Demo Project

## Development

- **Dev Server Port**: 3456 (run `npm run dev`)
- **Tech Stack**: Next.js 16, React, TypeScript, TailwindCSS

## Project Structure

- `/src/app` - Next.js App Router pages and API routes
- `/src/components` - React components
  - `FileBrowserModal.tsx` - Unified file browser with 4 tabs (目录树, 最近浏览, Git 变更, Git 历史)
  - `TabManager.tsx` - Main tab manager component
  - `Chat.tsx` - Chat interface component
  - `ChatInput.tsx` - Chat input component

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
npm run lint     # Run ESLint
```

## 项目特性

- **纯本地应用**: 所有 API 请求延迟在 10ms 内
- **不需要接口缓存**: 本地请求足够快，缓存带来的性能收益可忽略，反而会引入数据一致性问题

## Claude Code 使用规范

- **浏览器测试**: 使用 `evaluate_script` 操作 DOM，避免使用 `take_screenshot`（消耗大量 token）
- **非必要不截图**: 只在需要视觉确认时才截图
- **MCP 工具**: 非必要不使用 MCP 工具，除非用户消息明确要求（如 "use xxx"）
