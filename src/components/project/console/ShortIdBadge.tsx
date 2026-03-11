'use client';

import { useState, useCallback, memo } from 'react';
import { toast } from '../../shared/Toast';

/** 非默认端口时返回 --port 后缀 */
function getPortSuffix(): string {
  const defaultPort = '3457';
  const port = typeof window !== 'undefined' ? window.location.port : defaultPort;
  return port !== defaultPort ? ` --port ${port}` : '';
}

interface ShortIdBadgeProps {
  shortId: string;
  /** CLI 子命令类型：terminal / browser */
  type: 'terminal' | 'browser';
  onRegister: () => void | Promise<void>;
  onUnregister: () => void | Promise<void>;
}

export const ShortIdBadge = memo(function ShortIdBadge({
  shortId,
  type,
  onRegister,
  onUnregister,
}: ShortIdBadgeProps) {
  const [registered, setRegistered] = useState(false);

  const handleClick = useCallback(async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (registered) {
      // 取消注册
      await onUnregister();
      setRegistered(false);
      toast(`已断开: ${shortId}`);
    } else {
      // 注册 + 复制帮助命令
      await onRegister();
      setRegistered(true);
      const cmd = `cock ${type} ${shortId}${getPortSuffix()}`;
      navigator.clipboard.writeText(cmd);
      toast(`已复制: ${cmd}`);
    }
  }, [registered, shortId, type, onRegister, onUnregister]);

  return (
    <button
      onClick={handleClick}
      className="inline-flex items-center gap-1 text-[10px] font-mono leading-none px-1.5 py-0.5 rounded flex-shrink-0 transition-colors bg-muted/60 hover:bg-muted text-muted-foreground"
      title={registered ? '点击断开连接' : '点击注册并复制 CLI 命令'}
    >
      <span className={`inline-block w-1.5 h-1.5 rounded-full ${registered ? 'bg-green-500' : 'bg-muted-foreground/40'}`} />
      {shortId}
    </button>
  );
});
