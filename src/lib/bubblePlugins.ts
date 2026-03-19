/**
 * Console 气泡插件系统
 *
 * 插件注册表 + 通用类型。新增气泡类型只需：
 *   1. 实现 BubblePlugin 接口
 *   2. 调用 registerBubble() 注册
 *   3. 在 bubbles/index.ts 中导入
 */

import type { ComponentType } from 'react';

// ============================================
// 通用气泡数据基类
// ============================================

/** 所有插件气泡共享的基础字段 */
export interface PluginItemBase {
  id: string;
  _type: string;        // 插件 type 标识，持久化时映射为 history entry.type
  timestamp: string;
  [key: string]: unknown;
}

// ============================================
// 气泡组件 Props（由 ConsoleView 注入）
// ============================================

/** 每个插件气泡组件接收的通用 props */
export interface BubbleComponentProps {
  item: PluginItemBase;
  selected: boolean;
  maximized: boolean;
  expandedHeight: number;
  bubbleContentHeight?: number;
  timestamp: string;
  onSelect: () => void;
  onClose: () => void;
  onToggleMaximize: () => void;
  onTitleMouseDown: () => void;
  /** 透传额外上下文（如 sleepingBubbles、addBrowserItem 等）*/
  extra?: Record<string, unknown>;
}

// ============================================
// 插件定义
// ============================================

export interface BubblePlugin {
  /** 唯一类型标识，如 'browser'、'database' */
  type: string;

  /** ID 前缀，如 'browser'、'db'，最终 id = `${prefix}-${timestamp}-${random}` */
  idPrefix: string;

  /** 输入路由：判断用户输入是否匹配此插件 */
  match: (input: string) => boolean;

  /** 解析用户输入 → 气泡数据字段（不含 id / _type / timestamp，由框架生成） */
  parse: (input: string) => Record<string, unknown>;

  /** 从持久化的 history entry 恢复气泡数据 */
  fromHistory: (entry: Record<string, unknown>) => Record<string, unknown>;

  /** 序列化为 history entry（不含公共字段 type/id/timestamp） */
  toHistory: (item: PluginItemBase) => Record<string, unknown>;

  /** 气泡渲染组件 */
  Component: ComponentType<BubbleComponentProps>;

  /** 关闭时的清理回调（如断开数据库连接） */
  onClose?: (item: PluginItemBase) => void | Promise<void>;
}

// ============================================
// 注册表
// ============================================

const registry = new Map<string, BubblePlugin>();

export function registerBubble(plugin: BubblePlugin) {
  registry.set(plugin.type, plugin);
}

export function getPlugin(type: string): BubblePlugin | undefined {
  return registry.get(type);
}

/** 遍历所有插件，找到第一个匹配输入的插件 */
export function matchInput(input: string): BubblePlugin | null {
  for (const plugin of registry.values()) {
    if (plugin.match(input)) return plugin;
  }
  return null;
}

export function getAllPlugins(): BubblePlugin[] {
  return Array.from(registry.values());
}

/** 生成插件气泡 ID */
export function generatePluginItemId(prefix: string): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
}
