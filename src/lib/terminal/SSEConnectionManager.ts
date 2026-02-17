// Per-command SSE 执行器
// 每个命令独立建立一个 fetch SSE 连接，命令结束后连接自动关闭
// 不再有全局连接、clientId、重连等复杂逻辑

interface ExecuteOptions {
  cwd: string;
  command: string;
  commandId: string;
  tabId: string;
  projectCwd: string;
  env?: Record<string, string>;
  onData: (type: string, data: Record<string, any>) => void;
  onError: (error: string) => void;
}

/**
 * 执行命令，返回 AbortController（用于 Ctrl+C 或页面卸载时中断 SSE 流）
 */
export async function executeCommand(options: ExecuteOptions): Promise<AbortController> {
  const { cwd, command, commandId, tabId, projectCwd, env, onData, onError } = options;

  const abortController = new AbortController();

  try {
    const response = await fetch('/api/terminal/execute', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cwd, command, commandId, tabId, projectCwd, env }),
      signal: abortController.signal,
    });

    if (!response.ok || !response.body) {
      onError(`HTTP ${response.status}: ${response.statusText}`);
      return abortController;
    }

    // 异步读取 SSE stream（不阻塞）
    readSSEStream(response.body, onData, onError, abortController.signal);
  } catch (error) {
    if ((error as Error).name !== 'AbortError') {
      onError((error as Error).message);
    }
  }

  return abortController;
}

/**
 * 读取 SSE stream，解析事件并分发到回调
 */
async function readSSEStream(
  body: ReadableStream<Uint8Array>,
  onData: (type: string, data: Record<string, any>) => void,
  onError: (error: string) => void,
  signal: AbortSignal,
) {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // 解析 SSE 格式：以 "data: " 开头，以 "\n\n" 结尾
      const parts = buffer.split('\n\n');
      buffer = parts.pop() || ''; // 最后一段可能不完整

      for (const part of parts) {
        const line = part.trim();
        if (!line.startsWith('data: ')) continue;

        try {
          const json = JSON.parse(line.slice(6));
          const { type, ...data } = json;
          onData(type, data);
        } catch {
          // 解析失败，忽略
        }
      }
    }
  } catch (error) {
    if ((error as Error).name !== 'AbortError' && !signal.aborted) {
      onError((error as Error).message);
    }
  } finally {
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/**
 * 中断命令（发送 SIGTERM）
 */
export async function interruptCommand(pid: number): Promise<void> {
  try {
    await fetch('/api/terminal/interrupt', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pid }),
    });
  } catch (error) {
    console.error('Failed to interrupt command:', error);
  }
}
