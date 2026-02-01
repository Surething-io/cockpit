# Cockpit 配色体系规范

## 概述

本项目参考 Cursor IDE / VS Code 的配色风格，支持 Light 和 Dark 两种主题模式。

## 当前状态分析

### 已定义的设计系统 (`globals.css`)

项目已有基于 Radix UI 的完整色阶定义：

| 类别 | Light 模式 | Dark 模式 | 用途 |
|------|-----------|----------|------|
| **Teal (品牌色)** | `--teal-1` ~ `--teal-12` | 同步调整 | 强调、链接、焦点环 |
| **Slate (灰色)** | `--slate-1` ~ `--slate-12` | 同步调整 | 背景、文字、边框 |
| **Red** | `--red-9/10/11` | 同步调整 | 错误、删除 |
| **Green** | `--green-9/10/11` | 同步调整 | 成功、新增 |
| **Amber** | `--amber-9/10/11` | 同步调整 | 警告 |

### 存在的问题

组件中大量使用 Tailwind 默认的 `gray-*` 色阶（约 300+ 处），而非已定义的语义化变量：

```tsx
// ❌ 当前写法 - 使用 Tailwind 默认 gray
className="bg-gray-100 dark:bg-gray-700 text-gray-900 dark:text-gray-100"

// ✅ 推荐写法 - 使用设计系统变量
className="bg-secondary text-foreground"
// 或使用 Slate 色阶
className="bg-slate-3 text-slate-12"
```

---

## 推荐配色规范

### 参考: VS Code / Cursor IDE 默认 Dark 主题

| 元素 | Hex 值 | 用途 |
|------|--------|------|
| `#1e1e1e` | 编辑器背景 |
| `#252526` | 侧边栏背景 |
| `#2d2d30` | 次级面板背景 |
| `#3e3e42` | 边框/分隔线 |
| `#007acc` | 强调色 (蓝色) |
| `#d4d4d4` | 主要文字 |
| `#cccccc` | 默认文字 |
| `#9cdcfe` | 变量 (语法高亮) |
| `#ce9178` | 字符串 (语法高亮) |

### 映射到项目设计系统

#### 背景色

| 语义 | Tailwind 类 | Light | Dark | 说明 |
|------|------------|-------|------|------|
| 页面背景 | `bg-background` | `slate-1` (#fafafa) | `slate-1` (#111113) | 最底层背景 |
| 卡片/面板 | `bg-card` | white | `slate-2` (#18181a) | 浮层、卡片 |
| 输入框/按钮 | `bg-secondary` | `slate-3` (#f0f0f2) | `slate-3` (#212124) | 交互元素 |
| 悬停状态 | `bg-accent` | `slate-4` | `slate-4` | hover 效果 |
| 选中状态 | `bg-brand/10` | teal-3 | teal-4 | 选中高亮 |

#### 文字色

| 语义 | Tailwind 类 | Light | Dark | 说明 |
|------|------------|-------|------|------|
| 主要文字 | `text-foreground` | `slate-12` | `slate-12` | 标题、正文 |
| 次要文字 | `text-muted-foreground` | `slate-11` | `slate-11` | 描述、提示 |
| 占位符 | `text-slate-9` | `slate-9` | `slate-9` | placeholder |
| 禁用文字 | `text-slate-8` | `slate-8` | `slate-8` | disabled |

#### 边框色

| 语义 | Tailwind 类 | Light | Dark | 说明 |
|------|------------|-------|------|------|
| 默认边框 | `border-border` | `slate-5` | `slate-6` | 分隔线、卡片边框 |
| 输入框边框 | `border-input` | `slate-5` | `slate-6` | 表单元素 |
| 焦点边框 | `ring-ring` | `teal-9` | `teal-9` | focus 状态 |

#### 状态色

| 语义 | Tailwind 类 | 颜色 | 说明 |
|------|------------|------|------|
| 成功/新增 | `text-green-11` / `bg-green-9` | Green | Git added, 成功提示 |
| 错误/删除 | `text-red-11` / `bg-red-9` | Red | Git deleted, 错误提示 |
| 警告/修改 | `text-amber-11` / `bg-amber-9` | Amber | Git modified, 警告提示 |
| 信息/链接 | `text-brand` / `bg-brand` | Teal | 链接、强调 |

---

## 迁移指南

### 第一步：替换灰色系

```tsx
// 背景
bg-white          → bg-card
bg-gray-50        → bg-secondary (或 bg-slate-2)
bg-gray-100       → bg-slate-3
bg-gray-200       → bg-slate-4
bg-gray-700       → bg-slate-4 (dark)
bg-gray-800       → bg-slate-3 (dark)
bg-gray-900       → bg-slate-2 (dark)

// 文字
text-gray-900     → text-foreground
text-gray-700     → text-foreground
text-gray-600     → text-muted-foreground
text-gray-500     → text-muted-foreground
text-gray-400     → text-slate-9
text-gray-300     → text-slate-10 (dark)
text-gray-100     → text-foreground (dark)

// 边框
border-gray-200   → border-border
border-gray-300   → border-border
border-gray-600   → border-border (dark)
border-gray-700   → border-border (dark)
```

### 第二步：替换蓝色强调

```tsx
// 当前项目使用 Teal 作为品牌色，保留蓝色仅用于特殊场景
bg-blue-500       → bg-brand
text-blue-600     → text-brand
ring-blue-500     → ring-ring
```

### 第三步：统一状态色

```tsx
// 成功
text-green-600    → text-green-11
bg-green-100      → bg-green-9/10

// 错误
text-red-500      → text-red-11
bg-red-100        → bg-red-9/10

// 警告
text-yellow-600   → text-amber-11
bg-yellow-100     → bg-amber-9/10
```

---

## 组件色彩规范速查

### 按钮

```tsx
// 主要按钮
<button className="bg-primary text-primary-foreground hover:bg-primary/90">

// 次要按钮
<button className="bg-secondary text-secondary-foreground hover:bg-accent">

// 危险按钮
<button className="bg-destructive text-destructive-foreground hover:bg-destructive/90">
```

### 输入框

```tsx
<input className="bg-background border-input text-foreground placeholder:text-slate-9 focus:ring-ring" />
```

### 卡片/面板

```tsx
<div className="bg-card text-card-foreground border-border rounded-lg shadow" />
```

### 列表项

```tsx
// 默认
<li className="text-foreground hover:bg-accent" />

// 选中
<li className="bg-brand/10 text-brand-foreground" />
```

### 导航/标签

```tsx
// 活跃标签
<tab className="text-brand border-b-2 border-brand" />

// 非活跃标签
<tab className="text-muted-foreground hover:text-foreground" />
```

### Diff 视图

```tsx
// 新增行
<div className="bg-green-9/10 text-green-11" />

// 删除行
<div className="bg-red-9/10 text-red-11" />
```

---

## 附录: Tailwind 类映射表

| 旧类名 | 新类名 | 备注 |
|--------|--------|------|
| `bg-white dark:bg-gray-800` | `bg-card` | 卡片背景 |
| `bg-gray-50 dark:bg-gray-900` | `bg-secondary` | 次级背景 |
| `bg-gray-100 dark:bg-gray-700` | `bg-accent` | 悬停/选中背景 |
| `text-gray-900 dark:text-gray-100` | `text-foreground` | 主要文字 |
| `text-gray-500 dark:text-gray-400` | `text-muted-foreground` | 次要文字 |
| `border-gray-200 dark:border-gray-700` | `border-border` | 边框 |
| `bg-blue-50 dark:bg-blue-900/30` | `bg-brand/10` | 选中高亮 |
| `text-blue-600 dark:text-blue-400` | `text-brand` | 强调文字 |

---

## 参考资源

- [Radix UI Colors](https://www.radix-ui.com/colors)
- [VS Code Theme Color Reference](https://code.visualstudio.com/api/references/theme-color)
- [Cursor Themes Documentation](https://cursor.com/docs/configuration/themes)
- [shadcn/ui Theming](https://ui.shadcn.com/docs/theming)
