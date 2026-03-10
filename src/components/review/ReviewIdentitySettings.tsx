'use client';

import { useState, useRef, useEffect } from 'react';

interface IdentityProps {
  authorId: string;
  name: string;
  setName: (name: string) => void;
  randomize: () => void;
}

interface Props {
  identity: IdentityProps;
}

export function ReviewIdentitySettings({ identity }: Props) {
  const [open, setOpen] = useState(false);
  const [editName, setEditName] = useState('');
  const popoverRef = useRef<HTMLDivElement>(null);

  // Close on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (popoverRef.current && !popoverRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleSave = () => {
    const trimmed = editName.trim();
    if (trimmed && trimmed !== identity.name) {
      identity.setName(trimmed);
    }
    setOpen(false);
  };

  return (
    <div className="relative" ref={popoverRef}>
      <button
        onClick={() => { if (!open) setEditName(identity.name); setOpen(!open); }}
        className="px-2 py-1 text-xs rounded hover:bg-accent transition-colors flex items-center gap-1"
        title="身份设置"
      >
        <span className="w-5 h-5 rounded-full bg-brand/20 text-brand flex items-center justify-center text-[10px] font-bold">
          {identity.name.charAt(0)}
        </span>
        <span className="text-muted-foreground">{identity.name}</span>
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-56 bg-card border border-border rounded-lg shadow-lg p-3 z-50">
          <div className="text-xs text-muted-foreground mb-2">评审昵称</div>
          <input
            type="text"
            value={editName}
            onChange={e => setEditName(e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter') handleSave(); }}
            className="w-full px-2 py-1 text-sm bg-secondary border border-border rounded focus:outline-none focus:border-brand"
            autoFocus
          />
          <div className="flex items-center gap-2 mt-2">
            <button
              onClick={() => {
                identity.randomize();
                setOpen(false);
              }}
              className="px-2 py-1 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
            >
              随机
            </button>
            <div className="flex-1" />
            <button
              onClick={() => setOpen(false)}
              className="px-2 py-1 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
            >
              取消
            </button>
            <button
              onClick={handleSave}
              className="px-2 py-1 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors"
            >
              保存
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
