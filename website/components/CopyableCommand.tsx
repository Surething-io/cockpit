'use client';

import { useState } from 'react';

export function CopyableCommand({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);

  async function copy() {
    try {
      await navigator.clipboard.writeText(command);
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    } catch {
      // ignore
    }
  }

  return (
    <button
      onClick={copy}
      className="group flex items-center gap-3 rounded-md border border-border bg-card px-4 py-2.5 font-mono text-sm hover:border-brand/50 transition-colors"
      aria-label="Copy install command"
    >
      <span className="text-muted-foreground select-none">$</span>
      <span className="text-foreground">{command}</span>
      <span
        className={
          'ml-2 text-xs transition-colors ' +
          (copied ? 'text-brand' : 'text-muted-foreground group-hover:text-foreground')
        }
      >
        {copied ? '✓ Copied' : '⧉ Copy'}
      </span>
    </button>
  );
}
