'use client';

import { useSyncExternalStore } from 'react';

/**
 * Chrome 扩展的 content script（isolated world）往 <head> 插入：
 *   <meta name="cockpit-bridge" data-id="xxx" data-version="1.0.1">
 *
 * DOM 是共享的，页面侧可以读取。不修改 <html> 属性，不触发 hydration mismatch。
 */

interface CockpitBridge {
  id: string;
  version: string;
}

// ---------- 从 DOM 读取 ----------

function readFromDom(): CockpitBridge | null {
  if (typeof document === 'undefined') return null;
  const meta = document.querySelector('meta[name="cockpit-bridge"]') as HTMLMetaElement | null;
  if (!meta) return null;
  const id = meta.dataset.id;
  const version = meta.dataset.version;
  return id ? { id, version: version || 'unknown' } : null;
}

// ---------- 外部 store（singleton，所有组件共享） ----------

let snapshot: CockpitBridge | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

function subscribe(cb: () => void) {
  listeners.add(cb);

  // 每次有新订阅时尝试从 DOM 刷新（应对 meta 延迟插入的场景）
  const current = readFromDom();
  if (current && !snapshot) {
    snapshot = current;
    // 下一个微任务通知，避免在 subscribe 内同步触发
    Promise.resolve().then(notify);
  }

  return () => { listeners.delete(cb); };
}

function getSnapshot() { return snapshot; }
function getServerSnapshot() { return null; }

// 初始读取
if (typeof document !== 'undefined') {
  snapshot = readFromDom();
}

// 监听 <head> 子节点变化，捕获 meta 标签的动态插入
if (typeof MutationObserver !== 'undefined' && typeof document !== 'undefined') {
  const observer = new MutationObserver(() => {
    const current = readFromDom();
    if (current && (!snapshot || current.id !== snapshot.id || current.version !== snapshot.version)) {
      snapshot = current;
      notify();
    }
  });
  // content script 会插入到 head 或 documentElement
  const target = document.head || document.documentElement;
  if (target) {
    observer.observe(target, { childList: true });
  }
}

// ---------- Hook ----------

export function useCockpitBridge(): CockpitBridge | null {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

// ---------- 命令式 API（给非 React 代码用） ----------

export function getCockpitBridge(): CockpitBridge | null {
  // 优先用缓存，fallback 实时读 DOM
  return snapshot ?? readFromDom();
}
