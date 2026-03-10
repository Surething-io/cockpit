'use client';

import { useState, useEffect, useCallback } from 'react';

interface ReviewSummary {
  id: string;
  title: string;
  active: boolean;
  createdAt: number;
  commentCount: number;
  sourceFile?: string;
}

interface ReviewListPanelProps {
  currentReviewId: string;
  onSelect: (reviewId: string) => void;
}

export function ReviewListPanel({ currentReviewId, onSelect }: ReviewListPanelProps) {
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);

  const fetchList = useCallback(async () => {
    try {
      const res = await fetch('/api/review');
      if (res.ok) {
        const data = await res.json();
        setReviews(data.reviews || []);
      }
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchList();
  }, [fetchList]);

  // 切换评审时刷新列表
  useEffect(() => {
    fetchList();
  }, [currentReviewId, fetchList]);

  const handleToggleActive = useCallback(async (e: React.MouseEvent, id: string, currentActive: boolean) => {
    e.stopPropagation();
    if (toggling) return;
    setToggling(id);
    try {
      const res = await fetch(`/api/review/${id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: !currentActive }),
      });
      if (res.ok) {
        setReviews(prev => prev.map(r => r.id === id ? { ...r, active: !currentActive } : r));
      }
    } catch { /* ignore */ }
    setToggling(null);
  }, [toggling]);

  const handleDelete = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/review/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setReviews(prev => prev.filter(r => r.id !== id));
        // 如果删了当前的，切到列表里第一个
        if (id === currentReviewId) {
          const remaining = reviews.filter(r => r.id !== id);
          if (remaining.length > 0) {
            onSelect(remaining[0].id);
          }
        }
      }
    } catch { /* ignore */ }
    setDeleting(null);
  }, [deleting, currentReviewId, reviews, onSelect]);

  return (
    <div className="h-full flex flex-col bg-secondary/50">
      <div className="px-3 py-2 border-b border-border flex-shrink-0">
        <span className="text-xs font-medium text-muted-foreground">所有评审</span>
        <span className="text-xs text-muted-foreground/60 ml-1.5">{reviews.length}</span>
      </div>
      <div className="flex-1 overflow-y-auto">
        {reviews.map((r) => (
          <div
            key={r.id}
            onClick={() => onSelect(r.id)}
            className={`group px-3 py-2 cursor-pointer border-b border-border/50 transition-colors ${
              r.id === currentReviewId
                ? 'bg-accent/60'
                : 'hover:bg-accent/30'
            }`}
          >
            <div className="flex items-center gap-1.5 min-w-0">
              {/* 状态点 */}
              <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                r.active ? 'bg-green-500' : 'bg-muted-foreground/40'
              }`} />
              {/* 标题 */}
              <span className="text-xs truncate flex-1">{r.title}</span>
              {/* 开关按钮 */}
              <button
                onClick={(e) => handleToggleActive(e, r.id, r.active)}
                className={`flex-shrink-0 p-0.5 rounded text-muted-foreground/0 group-hover:text-muted-foreground/60 hover:!text-foreground hover:!bg-accent transition-colors ${
                  toggling === r.id ? 'opacity-50 pointer-events-none' : ''
                }`}
                title={r.active ? '关闭评审' : '重新开放'}
              >
                {r.active ? (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64a9 9 0 1 1-12.73 0"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                ) : (
                  <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M18.36 6.64A9 9 0 0 1 12 21 9 9 0 0 1 5.64 6.64"/><line x1="12" y1="2" x2="12" y2="12"/></svg>
                )}
              </button>
              {/* 删除按钮 */}
              <button
                onClick={(e) => handleDelete(e, r.id)}
                className={`flex-shrink-0 p-0.5 rounded text-muted-foreground/0 group-hover:text-muted-foreground/60 hover:!text-red-500 hover:!bg-red-500/10 transition-colors ${
                  deleting === r.id ? 'opacity-50 pointer-events-none' : ''
                }`}
                title="删除评审"
              >
                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                  <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
                </svg>
              </button>
            </div>
            {/* 评论数 */}
            {r.commentCount > 0 && (
              <div className="text-[10px] text-muted-foreground/50 mt-0.5 pl-3">
                {r.commentCount} 条评论
              </div>
            )}
          </div>
        ))}
        {reviews.length === 0 && (
          <div className="px-3 py-4 text-xs text-muted-foreground/50 text-center">
            暂无评审
          </div>
        )}
      </div>
    </div>
  );
}
