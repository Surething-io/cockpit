'use client';

import { useState, useCallback, memo } from 'react';
import { toast } from '../../shared/Toast';

/** Use cock-dev on the dev port; use cock for all others (prod port is auto-detected from ~/.cockpit/server.json) */
function getCockBin(): string {
  const port = typeof window !== 'undefined' ? window.location.port : '3457';
  return port === '3456' ? 'cock-dev' : 'cock';
}

interface ShortIdBadgeProps {
  shortId: string;
  /** CLI subcommand type: terminal / browser */
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
      // Unregister
      await onUnregister();
      setRegistered(false);
      toast(`已断开: ${shortId}`);
    } else {
      // Register + copy help command
      await onRegister();
      setRegistered(true);
      const cmd = `${getCockBin()} ${type} ${shortId}`;
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
