'use client';

import { useState, useEffect, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { toast } from './Toast';

interface ReviewInfo {
  id: string;
  active: boolean;
  updatedAt?: number;
}

interface ShareReviewToggleProps {
  /** File content (used to create/update review) */
  content: string;
  /** Relative path sourceFile (used to match review) */
  sourceFile: string;
}

/**
 * Share review toggle switch component.
 * - Queries whether the current file already has a review
 * - Switch ON → create/update review, copy link
 * - Switch OFF → deactivate review (active: false)
 * - Show updated time + link to view
 */
export function ShareReviewToggle({ content, sourceFile }: ShareReviewToggleProps) {
  const { t } = useTranslation();
  const [reviewInfo, setReviewInfo] = useState<ReviewInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [toggling, setToggling] = useState(false);

  // Query review status for the current file
  useEffect(() => {
    if (!sourceFile) { setLoading(false); return; }
    let cancelled = false;
    fetch('/api/review')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(data => {
        if (cancelled) return;
        const match = (data.reviews as Array<{ id: string; active: boolean; updatedAt?: number; sourceFile?: string }>)
          .find(r => r.sourceFile === sourceFile);
        setReviewInfo(match ? { id: match.id, active: match.active, updatedAt: match.updatedAt } : null);
      })
      .catch(() => {})
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [sourceFile]);

  const isSharing = reviewInfo?.active === true;

  // Enable sharing: create/update review
  const enableShare = useCallback(async () => {
    setToggling(true);
    try {
      const title = sourceFile.split('/').pop() || sourceFile;
      const res = await fetch('/api/review', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, content, sourceFile }),
      });
      if (!res.ok) throw new Error('Failed');
      const data = await res.json();
      const review = data.review;
      setReviewInfo({ id: review.id, active: true, updatedAt: review.updatedAt || review.createdAt });

      // Copy share link
      try {
        const infoRes = await fetch('/api/review/share-info');
        const info = await infoRes.json();
        const shareUrl = info.shareBase
          ? `${info.shareBase}/review/${review.id}`
          : `${window.location.origin}/review/${review.id}`;
        await navigator.clipboard.writeText(shareUrl);
      } catch { /* ignore */ }

      toast(review.existing ? t('toast.reviewUpdated') : t('toast.reviewCreated'), 'success');
    } catch {
      toast(t('toast.reviewCreateFailed'), 'error');
    } finally {
      setToggling(false);
    }
  }, [content, sourceFile]);

  // Disable sharing
  const disableShare = useCallback(async () => {
    if (!reviewInfo) return;
    setToggling(true);
    try {
      const res = await fetch(`/api/review/${reviewInfo.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active: false }),
      });
      if (!res.ok) throw new Error('Failed');
      setReviewInfo(prev => prev ? { ...prev, active: false } : null);
      toast(t('toast.sharingClosed'), 'success');
    } catch {
      toast(t('toast.sharingCloseFailed'), 'error');
    } finally {
      setToggling(false);
    }
  }, [reviewInfo]);

  const handleToggle = useCallback(() => {
    if (toggling) return;
    if (isSharing) {
      disableShare();
    } else {
      enableShare();
    }
  }, [toggling, isSharing, enableShare, disableShare]);

  const handleOpenReview = useCallback(() => {
    if (!reviewInfo) return;
    window.open(`${window.location.origin}/review/${reviewInfo.id}`, '_blank');
  }, [reviewInfo]);

  const formatTime = (ts: number) => {
    const d = new Date(ts);
    const month = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    const hours = String(d.getHours()).padStart(2, '0');
    const minutes = String(d.getMinutes()).padStart(2, '0');
    return `${month}-${day} ${hours}:${minutes}`;
  };

  if (loading) return null;

  return (
    <div className="flex items-center gap-2">
      {/* Switch */}
      <button
        onClick={handleToggle}
        disabled={toggling}
        className={`relative inline-flex h-4 w-7 items-center rounded-full transition-colors ${
          toggling ? 'opacity-50 cursor-wait' : 'cursor-pointer'
        } ${isSharing ? 'bg-green-500' : 'bg-muted-foreground/30'}`}
        title={isSharing ? t('review.closeSharing') : t('review.enableSharing')}
      >
        <span
          className={`inline-block h-3 w-3 rounded-full bg-white transition-transform ${
            isSharing ? 'translate-x-3.5' : 'translate-x-0.5'
          }`}
        />
      </button>
      <span className={`text-[11px] ${isSharing ? 'text-green-600 dark:text-green-400' : 'text-muted-foreground'}`}>
        {isSharing ? t('review.sharing') : t('review.notShared')}
      </span>

      {/* Update time + link */}
      {reviewInfo && reviewInfo.updatedAt && (
        <>
          <span className="text-[10px] text-muted-foreground">
            {formatTime(reviewInfo.updatedAt)}
          </span>
          <button
            onClick={handleOpenReview}
            className="text-[11px] text-brand hover:underline"
          >
            {t('review.view')}
          </button>
        </>
      )}
    </div>
  );
}
