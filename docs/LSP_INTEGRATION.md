# LSP 集成方案：跳转定义 + 悬浮类型 + 引用查找

## 架构概览

```
┌─────────────────────────────────────────────────────┐
│  CodeViewer / CodeLine (前端)                        │
│  Cmd+Click → go-to-definition                       │
│  Hover → 类型信息                                    │
│  右键/快捷键 → find references                       │
└───────────────┬─────────────────────────────────────┘
                │ fetch
                ▼
┌─────────────────────────────────────────────────────┐
│  /api/lsp/* (API Routes)                            │
│  definition / hover / references / status           │
│  根据文件扩展名自动路由到对应 Language Server          │
└───────────────┬─────────────────────────────────────┘
                │
                ▼
┌─────────────────────────────────────────────────────┐
│  LSPServerRegistry (进程管理，globalThis 持久化)      │
│  每种语言最多 1 个实例，跨项目共享                      │
│  ├─ TypeScript/JS → tsserver（项目自带 typescript）   │
│  ├─ Python → pyright（需系统安装）                    │
│  └─ 未来: Go → gopls, Rust → rust-analyzer ...      │
└─────────────────────────────────────────────────────┘
```

## 进程管理策略

- **每种语言最多 1 个实例**，跨所有 worktree / 项目共享
- **懒启动**：首次对该语言文件发起 LSP 请求时才启动
- **不回收**：启动后常驻，直到浏览器关闭
- 内存：tsserver ~20-50MB，pyright ~50-80MB（均排除 node_modules / venv）
- tsserver 支持同时 open 多个目录的文件，自动查找各自的 tsconfig.json
- pyright 同理，根据文件路径查找 pyrightconfig.json / pyproject.toml

## 语言路由

根据文件扩展名自动选择 Language Server：

```typescript
function getLanguageServer(filePath: string): 'typescript' | 'python' | null {
  const ext = filePath.split('.').pop()?.toLowerCase();
  if (['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs'].includes(ext)) return 'typescript';
  if (['py', 'pyi'].includes(ext)) return 'python';
  return null; // 不支持的语言，前端不显示 LSP 功能
}
```

## 阶段一：后端 - Language Server 进程管理

### 1.1 新建 `src/lib/lsp/LSPServerRegistry.ts`

参考 `RunningCommandRegistry.ts` 的 globalThis + Symbol 模式：

```typescript
interface LSPServer {
  language: string;        // 'typescript' | 'python'
  process: ChildProcess;
  stdin: Writable;
  stdout: Readable;
  seq: number;             // 请求序号（tsserver 用）
  pendingRequests: Map<number, { resolve, reject, timer }>;
  openedFiles: Set<string>; // 已 open 的文件，避免重复 open
  ready: boolean;           // 初始化完成标志
}
```

核心方法：
- `getOrCreateServer(language)` — 每种语言单例，已有则复用
- `sendRequest(language, command, args)` → `Promise<response>`
- `openFile(language, filePath, content)` — 通知 LS 打开/更新文件
- `shutdown(language)` — 优雅关闭
- `shutdownAll()` — 进程退出时清理

### 1.2 新建 `src/lib/lsp/tsserverAdapter.ts`

tsserver 使用自有协议（非标准 LSP），封装为统一接口：

```typescript
// tsserver 原生协议
// 写入 stdin: JSON 对象 + 换行
// 读取 stdout: Content-Length header + JSON body

interface TSServerAdapter {
  spawn(): ChildProcess;
  // 统一转换为 LSP 风格的请求/响应
  definition(file, line, col): Promise<Location[]>;
  hover(file, line, col): Promise<HoverInfo>;
  references(file, line, col): Promise<Location[]>;
  openFile(file, content): void;
}
```

启动命令：
```bash
node <project>/node_modules/typescript/lib/tsserver.js --disableAutomaticTypingAcquisition
```

如果项目没有 typescript，用 Cockpit 自带的。

### 1.3 新建 `src/lib/lsp/pyrightAdapter.ts`

Pyright 使用标准 LSP 协议（JSON-RPC 2.0）：

```typescript
interface PyrightAdapter {
  spawn(): ChildProcess;
  // 标准 LSP 协议
  initialize(rootUri): Promise<void>;
  definition(file, line, col): Promise<Location[]>;
  hover(file, line, col): Promise<HoverInfo>;
  references(file, line, col): Promise<Location[]>;
  didOpen(file, content): void;
}
```

启动命令：
```bash
pyright-langserver --stdio
# 或 basedpyright-langserver --stdio
```

需要系统已安装 pyright（`pip install pyright` 或 `npm install -g pyright`）。
启动前检测是否可用，不可用则该语言 LSP 功能禁用。

### 1.4 统一接口 `src/lib/lsp/types.ts`

```typescript
// 所有 Language Server adapter 实现此接口
interface LanguageServerAdapter {
  language: string;
  spawn(): ChildProcess;
  definition(file: string, line: number, col: number): Promise<Location[]>;
  hover(file: string, line: number, col: number): Promise<HoverInfo | null>;
  references(file: string, line: number, col: number): Promise<Location[]>;
  openFile(file: string, content: string): void;
  shutdown(): void;
}

interface Location {
  file: string;
  line: number;
  column: number;
  lineText?: string; // 该行源码，用于前端展示
}

interface HoverInfo {
  displayString: string;  // 类型签名
  documentation?: string; // JSDoc / docstring
  kind?: string;          // function / variable / class ...
}
```

## 阶段二：后端 - API Routes

所有 API 统一入口，根据文件扩展名路由到对应 adapter。

### 2.1 `src/app/api/lsp/definition/route.ts`

```
POST { cwd, filePath, line, column }
→ { definitions: Location[] }
```

流程：
1. `getLanguageServer(filePath)` → 确定语言
2. `getOrCreateServer(language)` → 获取/启动实例
3. `openFile(filePath, content)` → 确保文件已打开
4. `definition(filePath, line, column)` → 返回结果

### 2.2 `src/app/api/lsp/hover/route.ts`

```
POST { cwd, filePath, line, column }
→ { displayString, documentation, kind } | null
```

### 2.3 `src/app/api/lsp/references/route.ts`

```
POST { cwd, filePath, line, column }
→ { references: Location[] }
```

### 2.4 `src/app/api/lsp/status/route.ts`

```
GET
→ { servers: [{ language, pid, ready, openedFiles }] }
```

## 阶段三：前端 - Cmd+Click 跳转定义

### 3.1 CodeLine.tsx 改动

Shiki 输出的 HTML 每个 `<span>` 就是一个 token，可直接捕获点击：

```typescript
// 新增 props
onCmdClick?: (line: number, column: number) => void;

// code span 上添加 onClick
onClick={(e) => {
  if (!e.metaKey) return; // 只处理 Cmd+Click
  e.preventDefault();
  const { line, column } = getPositionFromClick(e, lineNum);
  onCmdClick?.(line, column);
}}
```

### 3.2 位置计算

从点击的 DOM 元素计算 column：
- 找到点击的 `<span>` 在代码行中的位置
- 累加前面所有 `<span>` 的 textContent 长度
- 加上 `window.getSelection().focusOffset`（在当前 span 内的偏移）

### 3.3 Cmd 键视觉反馈

CodeViewer 监听 `keydown/keyup`，设置 `cmdHeld` CSS class：
```css
.cmd-held span[style]:hover {
  text-decoration: underline;
  cursor: pointer;
}
```

### 3.4 跳转逻辑

CodeViewer 收到 definition 结果后：
- 同文件：滚动到目标行
- 不同文件：调用 `FileBrowserModal` 的文件打开 + 滚动到行（已有 `scrollToLine` prop）

## 阶段四：前端 - 悬浮类型信息

### 4.1 `src/hooks/useLSP.ts`

```typescript
// 300ms 延迟请求，避免鼠标快速划过时频繁调用
function useLSPHover(cwd, filePath) {
  const timerRef = useRef(null);
  const [hoverInfo, setHoverInfo] = useState(null);

  const onTokenMouseEnter = (line, column, rect) => {
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(async () => {
      const res = await fetch('/api/lsp/hover', { ... });
      setHoverInfo({ ...data, x: rect.x, y: rect.y });
    }, 300);
  };
  const onTokenMouseLeave = () => { clearTimeout(timerRef.current); setHoverInfo(null); };
}
```

### 4.2 `src/components/project/HoverTooltip.tsx`

Portal 渲染到 menuContainer（双屏布局约束）：

```
┌──────────────────────────────┐
│ const foo: string            │
│ ─────────────────            │
│ @param name — user name      │
└──────────────────────────────┘
```

`font-mono text-xs`，跟代码区一致。

## 阶段五：前端 - 引用查找

### 5.1 触发方式

Cmd+Click 跳转定义后，如果定义就是当前位置（已在定义处），自动转为查找引用。
也可在 FloatingToolbar 中添加「查找引用」按钮。

### 5.2 `src/components/project/ReferencesPanel.tsx`

在 CodeViewer 底部展示引用列表：

```
┌─ References (12) ──────────────────────────────┐
│ src/components/Chat.tsx:42                      │
│   const result = handleSubmit(input);           │
│ src/hooks/useChat.ts:15                         │
│   export function handleSubmit(msg: string)     │
└─────────────────────────────────────────────────┘
```

点击条目 → 打开对应文件并滚动到行号。

## 文件清单

### 新建文件
| 文件 | 说明 |
|------|------|
| `src/lib/lsp/types.ts` | 统一接口定义（Location, HoverInfo, LanguageServerAdapter） |
| `src/lib/lsp/LSPServerRegistry.ts` | 进程管理，每种语言单例（globalThis 持久化） |
| `src/lib/lsp/tsserverAdapter.ts` | tsserver 协议适配（原生协议 → 统一接口） |
| `src/lib/lsp/pyrightAdapter.ts` | pyright 协议适配（标准 LSP → 统一接口） |
| `src/app/api/lsp/definition/route.ts` | 跳转定义 API |
| `src/app/api/lsp/hover/route.ts` | 悬浮类型 API |
| `src/app/api/lsp/references/route.ts` | 引用查找 API |
| `src/app/api/lsp/status/route.ts` | 状态诊断 API |
| `src/components/project/HoverTooltip.tsx` | 悬浮类型气泡 |
| `src/components/project/ReferencesPanel.tsx` | 引用列表面板 |
| `src/hooks/useLSP.ts` | 前端 LSP hooks（hover、definition、references） |

### 修改文件
| 文件 | 改动 |
|------|------|
| `src/components/project/CodeLine.tsx` | 添加 `onClick`（Cmd+Click）+ `onMouseEnter/Leave`（hover） |
| `src/components/project/CodeViewer.tsx` | 集成 LSP hooks，渲染 HoverTooltip / ReferencesPanel |
| `src/components/project/useCodeViewerLogic.ts` | 添加 cmdHeld 状态，LSP 事件处理 |
| `src/components/project/FileBrowserModal.tsx` | 处理跨文件 definition 跳转 |

## 依赖

- **tsserver**：直接用项目的 `node_modules/typescript/lib/tsserver.js`，无项目 ts 时用 Cockpit 自带的
- **pyright**：需系统安装 `pyright-langserver`（`pip install pyright` 或 `npm i -g pyright`），不可用时自动禁用
- **零新 npm 依赖**

## 实现顺序

1. **阶段一**：types.ts + LSPServerRegistry + tsserverAdapter → 后端能启动/管理 tsserver
2. **阶段二**：API Routes → 能通过 HTTP 调用 definition/hover/references
3. **阶段三**：Cmd+Click 跳转定义 → 最核心功能可用
4. **阶段四**：悬浮类型信息 → 体验提升
5. **阶段五**：引用查找 → 完整三件套
6. **阶段六**：pyrightAdapter → Python 支持

每个阶段可独立测试，逐步交付。先做 TS/JS 全链路（阶段 1-5），再加 Python（阶段 6）。
