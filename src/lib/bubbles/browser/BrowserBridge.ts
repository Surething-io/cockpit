/**
 * BrowserBridge - 服务端核心
 *
 * 管理 browser bubble 的 shortId 注册表和 pending request。
 * CLI → API → WS → BrowserBubble → content script 的中间层。
 */

import { WebSocket } from 'ws';
import { toShortId } from '../../shortId';

// ============================================================================
// Registry
// ============================================================================

interface BrowserEntry {
  fullId: string;
  ws: WebSocket | null;
  lastSeen: number;
}

/** shortId → BrowserEntry */
const registry = new Map<string, BrowserEntry>();

/** fullId → shortId（反向索引） */
const fullIdToShort = new Map<string, string>();

export function registerBrowser(fullId: string, ws: WebSocket): string {
  const shortId = toShortId(fullId);
  registry.set(shortId, { fullId, ws, lastSeen: Date.now() });
  fullIdToShort.set(fullId, shortId);
  return shortId;
}

export function unregisterBrowser(fullId: string): void {
  const shortId = fullIdToShort.get(fullId);
  if (shortId) {
    registry.delete(shortId);
    fullIdToShort.delete(fullId);
  }
}

export function getBrowserByShortId(shortId: string): BrowserEntry | undefined {
  return registry.get(shortId);
}

export function updateBrowserWs(fullId: string, ws: WebSocket | null): void {
  const shortId = fullIdToShort.get(fullId);
  if (shortId) {
    const entry = registry.get(shortId);
    if (entry) {
      entry.ws = ws;
      entry.lastSeen = Date.now();
    }
  }
}

export function listBrowsers(): Array<{ shortId: string; fullId: string; connected: boolean }> {
  const result: Array<{ shortId: string; fullId: string; connected: boolean }> = [];
  for (const [shortId, entry] of registry) {
    result.push({
      shortId,
      fullId: entry.fullId,
      connected: entry.ws !== null && entry.ws.readyState === WebSocket.OPEN,
    });
  }
  return result;
}

// ============================================================================
// Pending Requests（API long-poll 等待 browser 响应）
// ============================================================================

interface PendingRequest {
  resolve: (data: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pendingRequests = new Map<string, PendingRequest>();

/**
 * 创建一个 pending request，等待 browser 响应
 */
export function createPendingRequest(reqId: string, timeout: number): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(reqId);
      reject(new Error(`Timeout after ${timeout}ms`));
    }, timeout);

    pendingRequests.set(reqId, { resolve, reject, timer });
  });
}

/**
 * Browser 响应到达，resolve 对应的 pending request
 */
export function resolvePendingRequest(reqId: string, ok: boolean, data: unknown, error?: string): void {
  const pending = pendingRequests.get(reqId);
  if (!pending) return;

  clearTimeout(pending.timer);
  pendingRequests.delete(reqId);

  if (ok) {
    pending.resolve(data);
  } else {
    pending.reject(new Error(error || 'Browser command failed'));
  }
}

/**
 * 向指定 browser 发送命令
 */
export function sendCommandToBrowser(
  shortId: string,
  reqId: string,
  action: string,
  params: Record<string, unknown>
): boolean {
  const entry = registry.get(shortId);
  if (!entry || !entry.ws || entry.ws.readyState !== WebSocket.OPEN) {
    return false;
  }

  entry.ws.send(JSON.stringify({
    type: 'browser:cmd',
    reqId,
    action,
    params,
  }));

  return true;
}
