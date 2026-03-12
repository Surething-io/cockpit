'use client';

import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import { useWebSocket } from '@/hooks/useWebSocket';

interface ReviewSummary {
  id: string;
  title: string;
  active: boolean;
  createdAt: number;
  updatedAt?: number;
  commentCount: number;
  lastCommentAt?: number;
  sourceFile?: string;
}

const LS_KEY = 'review-last-viewed';

function getLastViewed(): Record<string, number> {
  try { return JSON.parse(localStorage.getItem(LS_KEY) || '{}'); } catch { return {}; }
}

function setLastViewed(id: string) {
  const map = getLastViewed();
  map[id] = Date.now();
  localStorage.setItem(LS_KEY, JSON.stringify(map));
}

function formatTime(ts: number) {
  const d = new Date(ts);
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const dd = String(d.getDate()).padStart(2, '0');
  const hh = String(d.getHours()).padStart(2, '0');
  const min = String(d.getMinutes()).padStart(2, '0');
  return `${mm}-${dd} ${hh}:${min}`;
}

/** 判断某个 review 是否有未读评论 */
function hasUnread(r: ReviewSummary, lastViewed: Record<string, number>): boolean {
  if (!r.lastCommentAt) return false;
  const viewed = lastViewed[r.id];
  return !viewed || r.lastCommentAt > viewed;
}

/**
 * ReviewDropdown - TopBar 中的评审管理下拉面板
 * 功能对齐 ReviewListPanel：列表、状态、toggle active、删除、拖拽排序
 * + 新评论红点通知（fswatch → ws/watch → review 事件）
 */
export function ReviewDropdown({ cwd }: { cwd?: string }) {
  const [open, setOpen] = useState(false);
  const [reviews, setReviews] = useState<ReviewSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [deleting, setDeleting] = useState<string | null>(null);
  const [toggling, setToggling] = useState<string | null>(null);
  const [tooltip, setTooltip] = useState<{ id: string; text: string; top: number; left: number } | null>(null);
  const [lastViewed, setLastViewedState] = useState<Record<string, number>>({});

  const dropdownRef = useRef<HTMLDivElement>(null);
  const dragId = useRef<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);

  // 初始化 lastViewed from localStorage
  useEffect(() => {
    setLastViewedState(getLastViewed());
  }, []);

  // 点击外部关闭
  useEffect(() => {
    if (!open) return;
    const handleClick = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  // 拉取列表
  const fetchList = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/review');
      if (res.ok) {
        const data = await res.json();
        setReviews(data.reviews || []);
      }
    } catch { /* ignore */ }
    setLoading(false);
  }, []);

  // 打开面板时加载
  useEffect(() => {
    if (open) fetchList();
  }, [open, fetchList]);

  // 订阅 /ws/watch 的 review 事件，收到后静默刷新列表（更新红点状态）
  const handleWsMessage = useCallback((msg: unknown) => {
    const { data } = msg as { type: string; data: Array<{ type: string }> };
    if (data?.some(e => e.type === 'review')) {
      fetchList();
    }
  }, [fetchList]);

  useWebSocket({
    url: `/ws/watch?cwd=${encodeURIComponent(cwd || '/')}`,
    onMessage: handleWsMessage,
    enabled: !!cwd,
  });

  // 组件挂载时也拉一次（用于初始红点判断）
  useEffect(() => { fetchList(); }, [fetchList]);

  // 计算是否有任何未读
  const hasAnyUnread = useMemo(() => {
    return reviews.some(r => hasUnread(r, lastViewed));
  }, [reviews, lastViewed]);

  // 点击 review → 标记已读 + 新标签页打开
  const handleOpen = useCallback((id: string) => {
    setLastViewed(id);
    setLastViewedState(getLastViewed());
    window.open(`${window.location.origin}/review/${id}`, '_blank');
  }, []);

  // Toggle active
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

  // Delete
  const handleDelete = useCallback(async (e: React.MouseEvent, id: string) => {
    e.stopPropagation();
    if (deleting) return;
    setDeleting(id);
    try {
      const res = await fetch(`/api/review/${id}`, { method: 'DELETE' });
      if (res.ok) {
        setReviews(prev => prev.filter(r => r.id !== id));
      }
    } catch { /* ignore */ }
    setDeleting(null);
  }, [deleting]);

  // Drag & drop
  const handleDragStart = useCallback((e: React.DragEvent, id: string) => {
    dragId.current = id;
    e.dataTransfer.effectAllowed = 'move';
    const el = e.currentTarget as HTMLElement;
    requestAnimationFrame(() => el.classList.add('opacity-30'));
  }, []);

  const handleDragEnd = useCallback((e: React.DragEvent) => {
    dragId.current = null;
    setDropTarget(null);
    if (e.currentTarget instanceof HTMLElement) {
      e.currentTarget.classList.remove('opacity-30');
    }
  }, []);

  const handleDragOver = useCallback((e: React.DragEvent, id: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    if (dragId.current && dragId.current !== id) {
      setDropTarget(id);
    }
  }, []);

  const handleDrop = useCallback((e: React.DragEvent, targetId: string) => {
    e.preventDefault();
    setDropTarget(null);
    const sourceId = dragId.current;
    dragId.current = null;
    if (!sourceId || sourceId === targetId) return;

    setReviews(prev => {
      const list = [...prev];
      const fromIdx = list.findIndex(r => r.id === sourceId);
      const toIdx = list.findIndex(r => r.id === targetId);
      if (fromIdx === -1 || toIdx === -1) return prev;
      const [item] = list.splice(fromIdx, 1);
      list.splice(toIdx, 0, item);

      const order = list.map(r => r.id);
      fetch('/api/review/order', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ order }),
      }).catch(() => {});

      return list;
    });
  }, []);

  return (
    <div ref={dropdownRef} className="relative">
      <button
        onClick={() => setOpen(o => !o)}
        className={`relative p-2 rounded-lg transition-colors ${
          open
            ? 'text-foreground bg-accent'
            : 'text-muted-foreground hover:text-foreground hover:bg-accent'
        }`}
        title="评审管理"
      >
        <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5H7a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2V7a2 2 0 00-2-2h-2M9 5a2 2 0 002 2h2a2 2 0 002-2M9 5a2 2 0 012-2h2a2 2 0 012 2m-6 9l2 2 4-4" />
        </svg>
        {/* 按钮级红点 */}
        {hasAnyUnread && (
          <span className="absolute top-1 right-1 w-2 h-2 bg-red-500 rounded-full" />
        )}
      </button>

      {open && (
        <div className="absolute right-0 top-full mt-1 w-64 bg-popover border border-border rounded-lg shadow-xl z-50 overflow-hidden">
          {/* Header */}
          <div className="px-3 py-2 border-b border-border flex items-center justify-between">
            <div>
              <span className="text-xs font-medium text-muted-foreground">所有评审</span>
              <span className="text-xs text-muted-foreground/60 ml-1.5">{reviews.length}</span>
            </div>
            <button
              onClick={fetchList}
              className="p-0.5 text-muted-foreground hover:text-foreground rounded transition-colors"
              title="刷新"
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15" />
              </svg>
            </button>
          </div>

          {/* List */}
          <div className="max-h-80 overflow-y-auto">
            {loading && reviews.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground/50 text-center">加载中...</div>
            ) : reviews.length === 0 ? (
              <div className="px-3 py-4 text-xs text-muted-foreground/50 text-center">暂无评审</div>
            ) : (
              reviews.map((r) => {
                const unread = hasUnread(r, lastViewed);
                return (
                  <div
                    key={r.id}
                    draggable
                    onDragStart={(e) => handleDragStart(e, r.id)}
                    onDragEnd={handleDragEnd}
                    onDragOver={(e) => handleDragOver(e, r.id)}
                    onDrop={(e) => handleDrop(e, r.id)}
                    onMouseEnter={(e) => {
                      const rect = e.currentTarget.getBoundingClientRect();
                      setTooltip({ id: r.id, text: r.title, top: rect.top + rect.height / 2, left: rect.left });
                    }}
                    onMouseLeave={() => setTooltip(prev => prev?.id === r.id ? null : prev)}
                    onClick={() => handleOpen(r.id)}
                    className={`group px-3 py-2 cursor-pointer border-b transition-colors ${
                      dropTarget === r.id
                        ? 'border-b-brand border-t border-t-transparent'
                        : 'border-b-border/50'
                    } hover:bg-accent/30`}
                  >
                    <div className="flex items-center gap-1.5 min-w-0">
                      {/* 状态点：有未读评论时红色，否则按 active 状态显示 */}
                      <span className={`w-1.5 h-1.5 rounded-full flex-shrink-0 ${
                        unread ? 'bg-red-500' : r.active ? 'bg-green-500' : 'bg-muted-foreground/40'
                      }`} />
                      {/* 标题 */}
                      <span className={`text-xs truncate flex-1 ${unread ? 'font-medium text-foreground' : ''}`}>{r.title}</span>
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
                    {/* 更新时间 + 评论数 */}
                    <div className="flex items-center gap-2 text-[10px] text-muted-foreground/50 mt-0.5 pl-3">
                      <span>{formatTime(r.updatedAt || r.createdAt)}</span>
                      {r.commentCount > 0 && <span>{r.commentCount} 条评论</span>}
                    </div>
                  </div>
                );
              })
            )}
          </div>
        </div>
      )}

      {/* Tooltip */}
      {tooltip && open && (
        <div
          className="fixed z-[60] px-2 py-1 text-xs bg-popover text-popover-foreground border border-border rounded shadow-md whitespace-nowrap pointer-events-none"
          style={{ top: tooltip.top, left: tooltip.left - 8, transform: 'translate(-100%, -50%)' }}
        >
          {tooltip.text}
        </div>
      )}
    </div>
  );
}
