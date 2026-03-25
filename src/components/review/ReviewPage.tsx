'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ReviewMarkdownPanel } from './ReviewMarkdownPanel';
import { ReviewCommentPanel } from './ReviewCommentPanel';
import { ReviewIdentitySettings } from './ReviewIdentitySettings';
import { ReviewListPanel } from './ReviewListPanel';
import { NicknameModal } from './NicknameModal';
import { ReviewCommentsListModal, type UserNameMap } from './ReviewCommentsListModal';
import { useReviewIdentity } from '@/hooks/useReviewIdentity';
import { useTheme } from '@/components/shared/ThemeProvider';
import { ReviewData } from '@/lib/review-utils';
import { toast } from '@/components/shared/Toast';

interface ReviewPageProps {
  reviewId: string;
}

export function ReviewPage({ reviewId: initialReviewId }: ReviewPageProps) {
  const { t } = useTranslation();
  const [currentId, setCurrentId] = useState(initialReviewId);
  const [review, setReview] = useState<ReviewData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeCommentId, setActiveCommentId] = useState<string | null>(null);
  const [isAdmin, setIsAdmin] = useState(false);
  const identity = useReviewIdentity();
  const { resolvedTheme, setTheme } = useTheme();
  const [userNameMap, setUserNameMap] = useState<UserNameMap>({});
  const [showNicknameModal, setShowNicknameModal] = useState(false);
  const [showCommentsListModal, setShowCommentsListModal] = useState(false);

  // Fetch user name map
  const fetchUserMap = useCallback(async () => {
    try {
      const res = await fetch('/api/review/users');
      if (res.ok) {
        const data = await res.json();
        const map: UserNameMap = {};
        for (const [id, record] of Object.entries(data.users)) {
          map[id] = (record as { name: string }).name;
        }
        setUserNameMap(map);
      }
    } catch { /* ignore */ }
  }, []);

  // Load user map on mount
  useEffect(() => { fetchUserMap(); }, [fetchUserMap]);

  // Show nickname modal when name is not confirmed (after identity loads)
  useEffect(() => {
    if (!identity.loading && identity.authorId && !identity.nameConfirmed) {
      setShowNicknameModal(true);
    }
  }, [identity.loading, identity.authorId, identity.nameConfirmed]);

  // Determine admin mode
  useEffect(() => {
    setIsAdmin(window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1');
  }, []);

  // Default to dark for review page
  useEffect(() => {
    const stored = localStorage.getItem('theme');
    if (!stored || stored === 'system') {
      setTheme('dark');
    }
  }, [setTheme]);

  // refs for cross-panel scroll
  const scrollToCommentRef = useRef<(commentId: string) => void>(undefined);
  const scrollToHighlightRef = useRef<(commentId: string) => void>(undefined);

  // SPA review switch (keep old content until new data arrives to avoid flicker)
  const handleSelectReview = useCallback((id: string) => {
    if (id === currentId) return;
    setCurrentId(id);
    setError(null);
    setActiveCommentId(null);
    window.history.replaceState(null, '', `/review/${id}`);
  }, [currentId]);

  // Fetch review data
  const fetchReview = useCallback(async () => {
    try {
      const res = await fetch(`/api/review/${currentId}`);
      if (!res.ok) {
        if (res.status === 404) {
          setError(t('review.reviewNotExist'));
        } else {
          setError(t('review.loadFailed'));
        }
        return;
      }
      const data = await res.json();
      setReview(data.review);
      setError(null);
    } catch {
      setError(t('review.networkError'));
    } finally {
      setLoading(false);
    }
  }, [currentId]);

  // Initial load + switch
  useEffect(() => {
    fetchReview();
  }, [fetchReview]);

  // Polling for multi-user refresh (every 10s) + also refresh user name map
  useEffect(() => {
    const interval = setInterval(() => {
      fetchReview();
      fetchUserMap();
    }, 10000);
    return () => clearInterval(interval);
  }, [fetchReview, fetchUserMap]);

  // Add comment
  const handleAddComment = useCallback(async (
    content: string,
    anchor: { startOffset: number; endOffset: number; selectedText: string }
  ) => {
    if (!identity.authorId) return;
    try {
      const res = await fetch(`/api/review/${currentId}/comments`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          author: identity.name,
          authorId: identity.authorId,
          content,
          anchor,
        }),
      });
      if (res.ok) {
        await fetchReview();
      }
    } catch {
      toast(t('toast.addCommentFailed'), 'error');
    }
  }, [currentId, identity, fetchReview]);

  // Delete comment
  const handleDeleteComment = useCallback(async (commentId: string) => {
    try {
      const res = await fetch(`/api/review/${currentId}/comments?commentId=${commentId}`, {
        method: 'DELETE',
      });
      if (res.ok) {
        await fetchReview();
      }
    } catch {
      toast(t('toast.deleteCommentFailed'), 'error');
    }
  }, [currentId, fetchReview]);

  // Edit comment
  const handleEditComment = useCallback(async (commentId: string, content: string) => {
    try {
      const res = await fetch(`/api/review/${currentId}/comments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, content }),
      });
      if (res.ok) {
        await fetchReview();
      }
    } catch {
      toast(t('toast.editCommentFailed'), 'error');
    }
  }, [currentId, fetchReview]);

  // Toggle comment closed
  const handleToggleCommentClosed = useCallback(async (commentId: string, closed: boolean) => {
    try {
      const res = await fetch(`/api/review/${currentId}/comments`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, closed }),
      });
      if (res.ok) {
        await fetchReview();
      }
    } catch {
      toast(t('toast.operationFailed'), 'error');
    }
  }, [currentId, fetchReview, t]);

  // Add reply
  const handleAddReply = useCallback(async (commentId: string, content: string) => {
    if (!identity.authorId) return;
    try {
      const res = await fetch(`/api/review/${currentId}/replies`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          commentId,
          author: identity.name,
          authorId: identity.authorId,
          content,
        }),
      });
      if (res.ok) {
        await fetchReview();
      }
    } catch {
      toast(t('toast.addReplyFailed'), 'error');
    }
  }, [currentId, identity, fetchReview]);

  // Delete reply
  const handleDeleteReply = useCallback(async (commentId: string, replyId: string) => {
    try {
      const res = await fetch(
        `/api/review/${currentId}/replies?commentId=${commentId}&replyId=${replyId}`,
        { method: 'DELETE' }
      );
      if (res.ok) {
        await fetchReview();
      }
    } catch {
      toast(t('toast.deleteReplyFailed'), 'error');
    }
  }, [currentId, fetchReview]);

  // Edit reply
  const handleEditReply = useCallback(async (commentId: string, replyId: string, content: string) => {
    try {
      const res = await fetch(`/api/review/${currentId}/replies`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ commentId, replyId, content }),
      });
      if (res.ok) {
        await fetchReview();
      }
    } catch {
      toast(t('toast.editReplyFailed'), 'error');
    }
  }, [currentId, fetchReview]);

  // Copy share URL (use LAN IP + share port)
  const handleCopyLink = useCallback(async () => {
    try {
      const res = await fetch('/api/review/share-info');
      const info = await res.json();
      const shareUrl = info.shareBase
        ? `${info.shareBase}/review/${currentId}`
        : window.location.href;
      await navigator.clipboard.writeText(shareUrl);
      toast(t('toast.linkCopied'), 'success');
    } catch {
      toast(t('toast.copyFailed'), 'error');
    }
  }, [currentId]);


  // Click comment in right panel -> scroll to highlight in left panel
  const handleCommentClick = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
    scrollToHighlightRef.current?.(commentId);
  }, []);

  // Click highlight in left panel -> scroll to comment in right panel
  const handleHighlightClick = useCallback((commentId: string) => {
    setActiveCommentId(commentId);
    scrollToCommentRef.current?.(commentId);
  }, []);

  // Navigate to prev/next comment (sorted by document position)
  const navigateComment = useCallback((direction: 'prev' | 'next') => {
    if (!review || review.comments.length === 0) return;
    const sorted = [...review.comments].sort((a, b) => a.anchor.startOffset - b.anchor.startOffset);
    const currentIndex = activeCommentId ? sorted.findIndex(c => c.id === activeCommentId) : -1;
    let nextIndex: number;
    if (direction === 'next') {
      nextIndex = currentIndex < sorted.length - 1 ? currentIndex + 1 : 0;
    } else {
      nextIndex = currentIndex > 0 ? currentIndex - 1 : sorted.length - 1;
    }
    const target = sorted[nextIndex];
    setActiveCommentId(target.id);
    scrollToHighlightRef.current?.(target.id);
    scrollToCommentRef.current?.(target.id);
  }, [review, activeCommentId]);

  // Render main content area
  const renderContent = () => {
    if (loading) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-muted-foreground">{t('common.loading')}</div>
        </div>
      );
    }

    if (error || !review) {
      return (
        <div className="flex-1 flex items-center justify-center">
          <div className="text-center">
            <div className="text-xl mb-2">{error || t('review.reviewNotFound')}</div>
            <div className="text-sm text-muted-foreground">{t('review.checkLink')}</div>
          </div>
        </div>
      );
    }

    return (
      <div className="flex-1 flex overflow-hidden">
        {/* Left: Markdown preview */}
        <div className="flex-1 h-full border-r border-border overflow-hidden">
          <ReviewMarkdownPanel
            content={review.content}
            comments={review.comments}
            activeCommentId={activeCommentId}
            isActive={review.active}
            onAddComment={handleAddComment}
            onHighlightClick={handleHighlightClick}
            scrollToHighlightRef={scrollToHighlightRef}
          />
        </div>

        {/* Right: Comments */}
        <div className="w-[360px] h-full overflow-hidden flex-shrink-0">
          <ReviewCommentPanel
            comments={review.comments}
            activeCommentId={activeCommentId}
            currentAuthorId={identity.authorId}
            isActive={review.active}
            isAdmin={isAdmin}
            userNameMap={userNameMap}
            onCommentClick={handleCommentClick}
            onNavigateComment={navigateComment}
            onDeleteComment={handleDeleteComment}
            onEditComment={handleEditComment}
            onToggleCommentClosed={handleToggleCommentClosed}
            onAddReply={handleAddReply}
            onDeleteReply={handleDeleteReply}
            onEditReply={handleEditReply}
            scrollToCommentRef={scrollToCommentRef}
          />
        </div>
      </div>
    );
  };

  return (
    <div className="h-screen flex flex-col bg-background text-foreground overflow-hidden">
      {/* Nickname setup modal */}
      {showNicknameModal && (
        <NicknameModal
          currentName={identity.name}
          onConfirm={(name) => {
            identity.confirmName(name);
            setShowNicknameModal(false);
            fetchUserMap();
          }}
          onSkip={() => setShowNicknameModal(false)}
        />
      )}

      {/* Comments list modal */}
      {review && (
        <ReviewCommentsListModal
          isOpen={showCommentsListModal}
          onClose={() => setShowCommentsListModal(false)}
          comments={review.comments}
          reviewTitle={review.title}
          userNameMap={userNameMap}
          onCommentClick={(commentId) => {
            setActiveCommentId(commentId);
            scrollToHighlightRef.current?.(commentId);
            scrollToCommentRef.current?.(commentId);
          }}
        />
      )}

      {/* Top Bar */}
      {review && (
        <div className="py-2 bg-secondary border-b border-border flex-shrink-0 flex justify-center">
        <div className="w-full max-w-[1800px] px-4 flex items-center gap-3">
          <h1 className="text-sm font-semibold truncate">{review.title}</h1>
          <span className="text-[11px] text-muted-foreground flex-shrink-0">
            {t('review.updatedAt', { date: new Date(review.updatedAt || review.createdAt).toLocaleDateString(undefined, { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }) })}
          </span>
          <span className="flex-1" />

          {/* Status badge */}
          {!isAdmin && (
            <span className={`px-2 py-0.5 text-xs rounded-full ${
              review.active
                ? 'bg-green-500/15 text-green-600 dark:text-green-400'
                : 'bg-muted text-muted-foreground'
            }`}>
              {review.active ? t('review.active') : t('review.closed')}
            </span>
          )}

          {/* View all comments */}
          <button
            onClick={() => setShowCommentsListModal(true)}
            className="px-2 py-1 text-xs rounded hover:bg-accent transition-colors text-muted-foreground flex items-center gap-1"
            title={t('review.viewAllComments')}
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M7 8h10M7 12h4m1 8l-4-4H5a2 2 0 01-2-2V6a2 2 0 012-2h14a2 2 0 012 2v8a2 2 0 01-2 2h-3l-4 4z" />
            </svg>
            {t('review.viewCommentBtn')}
          </button>

          {/* Copy link */}
          <button
            onClick={handleCopyLink}
            className="px-2 py-1 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
          >
            {t('review.copyLink')}
          </button>

          {/* Theme toggle */}
          <button
            onClick={() => setTheme(resolvedTheme === 'dark' ? 'light' : 'dark')}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title={resolvedTheme === 'dark' ? t('settings.switchLight') : t('settings.switchDark')}
          >
            {resolvedTheme === 'dark' ? (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="12" cy="12" r="5"/><line x1="12" y1="1" x2="12" y2="3"/><line x1="12" y1="21" x2="12" y2="23"/><line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/><line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/><line x1="1" y1="12" x2="3" y2="12"/><line x1="21" y1="12" x2="23" y2="12"/><line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/><line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/></svg>
            ) : (
              <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z"/></svg>
            )}
          </button>

          {/* Identity settings */}
          <ReviewIdentitySettings identity={identity} />
        </div>
        </div>
      )}

      {/* Main content */}
      <div className="flex-1 flex justify-center overflow-hidden">
        <div className="w-full max-w-[1800px] flex overflow-hidden">
          {/* Left sidebar - review list (always mounted, width controlled by the component itself) */}
          <ReviewListPanel
            currentReviewId={currentId}
            onSelect={handleSelectReview}
            readOnly={!isAdmin}
            refreshTrigger={review?.comments.length}
            onViewComments={(reviewId) => {
              if (reviewId !== currentId) handleSelectReview(reviewId);
              setShowCommentsListModal(true);
            }}
          />

          {renderContent()}
        </div>
      </div>
    </div>
  );
}
