'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ReviewComment } from '@/lib/review-utils';
import { Portal } from '@/components/shared/Portal';
import { toast } from '@/components/shared/Toast';
import i18n from '@/lib/i18n';

/** authorId → latest nickname */
export type UserNameMap = Record<string, string>;

interface Props {
  isOpen: boolean;
  onClose: () => void;
  comments: ReviewComment[];
  reviewTitle: string;
  userNameMap: UserNameMap;
  onCommentClick?: (commentId: string) => void;
}

function formatTime(ts: number): string {
  const d = new Date(ts);
  return d.toLocaleString('zh-CN', {
    month: 'numeric',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

/** Format a single comment as copy text */
function formatSingleComment(
  comment: ReviewComment,
  userNameMap: UserNameMap,
  index?: number,
): string {
  const resolveAuthor = (authorId: string, fallback: string) =>
    userNameMap[authorId] || fallback;

  const parts: string[] = [];
  const prefix = index != null ? `[${index + 1}] ` : '';

  // Quoted text
  const anchor = comment.anchor.selectedText.length > 200
    ? comment.anchor.selectedText.slice(0, 197) + '...'
    : comment.anchor.selectedText;
  parts.push(`${prefix}${i18n.t('review.quoteRef', { text: anchor })}`);

  // Comment
  parts.push(i18n.t('review.commentAuthor', { author: resolveAuthor(comment.authorId, comment.author), content: comment.content }));

  // Replies
  for (const reply of comment.replies) {
    parts.push(i18n.t('review.replyAuthor', { author: resolveAuthor(reply.authorId, reply.author), content: reply.content }));
  }

  return parts.join('\n');
}

/** Format all comments as copy text */
function formatAllComments(
  comments: ReviewComment[],
  reviewTitle: string,
  userNameMap: UserNameMap,
): string {
  if (comments.length === 0) return '';

  const sorted = [...comments].sort((a, b) => a.anchor.startOffset - b.anchor.startOffset);
  const parts: string[] = [i18n.t('review.reviewSummary', { title: reviewTitle }), ''];

  sorted.forEach((comment, index) => {
    parts.push(formatSingleComment(comment, userNameMap, index));
    parts.push('');
  });

  parts.push(i18n.t('review.totalNComments', { count: comments.length }));
  return parts.join('\n').trim();
}

export function ReviewCommentsListModal({
  isOpen,
  onClose,
  comments,
  reviewTitle,
  userNameMap,
  onCommentClick,
}: Props) {
  const { t } = useTranslation();
  const [copyingId, setCopyingId] = useState<string | null>(null);
  const [copyingAll, setCopyingAll] = useState(false);

  if (!isOpen) return null;

  const sortedComments = [...comments].sort(
    (a, b) => a.anchor.startOffset - b.anchor.startOffset,
  );

  const resolveAuthor = (authorId: string, fallback: string) =>
    userNameMap[authorId] || fallback;

  const handleCopySingle = async (comment: ReviewComment) => {
    setCopyingId(comment.id);
    try {
      const text = formatSingleComment(comment, userNameMap);
      await navigator.clipboard.writeText(text);
      toast(t('toast.copiedComment'));
    } catch {
      toast(t('toast.copyFailed'), 'error');
    } finally {
      setCopyingId(null);
    }
  };

  const handleCopyAll = async () => {
    if (comments.length === 0) return;
    setCopyingAll(true);
    try {
      const text = formatAllComments(comments, reviewTitle, userNameMap);
      await navigator.clipboard.writeText(text);
      toast(t('toast.copiedAllComments'));
    } catch {
      toast(t('toast.copyFailed'), 'error');
    } finally {
      setCopyingAll(false);
    }
  };

  const handleClickComment = (commentId: string) => {
    onCommentClick?.(commentId);
    onClose();
  };

  // Separate: open comments and closed comments
  const openComments = sortedComments.filter(c => !c.closed);
  const closedComments = sortedComments.filter(c => c.closed);

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="w-full max-w-2xl max-h-[80vh] bg-card border border-border rounded-lg shadow-xl flex flex-col overflow-hidden"
        onClick={e => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border bg-secondary">
          <div className="flex items-center gap-2">
            <h2 className="text-sm font-semibold text-foreground">{t('review.allCommentsTitle')}</h2>
            <span className="text-xs text-muted-foreground">
              {t('review.commentsCountBrief', { count: comments.length })}
              {closedComments.length > 0 && ` (${t('review.closedCount', { count: closedComments.length })})`}
            </span>
            {comments.length > 0 && (
              <button
                onClick={handleCopyAll}
                disabled={copyingAll}
                className="p-1 rounded hover:bg-accent text-muted-foreground disabled:opacity-50"
                title={t('review.copyAllComments')}
              >
                {copyingAll ? (
                  <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
                ) : (
                  <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
                  </svg>
                )}
              </button>
            )}
          </div>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-accent text-muted-foreground"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-3">
          {comments.length === 0 ? (
            <div className="flex flex-col items-center justify-center py-12 text-muted-foreground">
              <div className="text-2xl mb-2">💬</div>
              <span className="text-sm">{t('review.noComments')}</span>
            </div>
          ) : (
            <div className="space-y-2">
              {/* Open comments */}
              {openComments.map((comment, idx) => (
                <CommentRow
                  key={comment.id}
                  comment={comment}
                  index={idx}
                  resolveAuthor={resolveAuthor}
                  copyingId={copyingId}
                  onCopy={handleCopySingle}
                  onClick={handleClickComment}
                />
              ))}

              {/* Closed comments */}
              {closedComments.length > 0 && (
                <>
                  <div className="text-[11px] text-muted-foreground/60 pt-2 pb-1 px-1">
                    {t('review.closedComments', { count: closedComments.length })}
                  </div>
                  {closedComments.map((comment, idx) => (
                    <CommentRow
                      key={comment.id}
                      comment={comment}
                      index={openComments.length + idx}
                      resolveAuthor={resolveAuthor}
                      copyingId={copyingId}
                      onCopy={handleCopySingle}
                      onClick={handleClickComment}
                      closed
                    />
                  ))}
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}

/** Single comment row */
function CommentRow({
  comment,
  index,
  resolveAuthor,
  copyingId,
  onCopy,
  onClick,
  closed,
}: {
  comment: ReviewComment;
  index: number;
  resolveAuthor: (authorId: string, fallback: string) => string;
  copyingId: string | null;
  onCopy: (comment: ReviewComment) => void;
  onClick: (commentId: string) => void;
  closed?: boolean;
}) {
  const truncatedAnchor = comment.anchor.selectedText.length > 100
    ? comment.anchor.selectedText.slice(0, 97) + '...'
    : comment.anchor.selectedText;

  return (
    <div
      className={`rounded-lg border border-border hover:border-muted-foreground/30 transition-all cursor-pointer group ${
        closed ? 'opacity-50' : ''
      }`}
      onClick={() => onClick(comment.id)}
    >
      {/* Quoted text */}
      <div className="px-3 pt-2.5 pb-1">
        <div className="text-xs bg-yellow-500/10 border-l-2 border-yellow-500 px-2 py-1 rounded-r text-muted-foreground truncate">
          {truncatedAnchor}
        </div>
      </div>

      {/* Comment content */}
      <div className="px-3 pt-1.5 pb-2 flex items-start gap-2">
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 mb-0.5">
            <span className="w-4 h-4 rounded-full bg-brand/20 text-brand flex items-center justify-center text-[9px] font-bold flex-shrink-0">
              {resolveAuthor(comment.authorId, comment.author).charAt(0)}
            </span>
            <span className="text-xs font-medium">
              {resolveAuthor(comment.authorId, comment.author)}
            </span>
            <span className="text-[10px] text-muted-foreground">
              {formatTime(comment.createdAt)}
            </span>
            {closed && (
              <span className="text-[10px] text-muted-foreground/60">{i18n.t('review.closedLabel')}</span>
            )}
          </div>
          <p className="text-sm text-foreground line-clamp-2 pl-6">
            {comment.content}
          </p>
          {/* Reply summary */}
          {comment.replies.length > 0 && (
            <div className="pl-6 mt-1 space-y-0.5">
              {comment.replies.slice(0, 3).map(reply => (
                <div key={reply.id} className="text-xs text-muted-foreground truncate">
                  <span className="font-medium">{resolveAuthor(reply.authorId, reply.author)}</span>
                  {': '}
                  {reply.content}
                </div>
              ))}
              {comment.replies.length > 3 && (
                <div className="text-[10px] text-muted-foreground/60">
                  {i18n.t('review.moreReplies', { count: comment.replies.length - 3 })}
                </div>
              )}
            </div>
          )}
        </div>

        {/* Copy button */}
        <button
          onClick={e => {
            e.stopPropagation();
            onCopy(comment);
          }}
          disabled={copyingId === comment.id}
          className="p-1 rounded opacity-0 group-hover:opacity-100 hover:bg-accent text-muted-foreground transition-opacity disabled:opacity-50 flex-shrink-0 mt-0.5"
          title={i18n.t('review.copyComment')}
        >
          {copyingId === comment.id ? (
            <span className="inline-block w-4 h-4 border-2 border-current border-t-transparent rounded-full animate-spin" />
          ) : (
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 16H6a2 2 0 01-2-2V6a2 2 0 012-2h8a2 2 0 012 2v2m-6 12h8a2 2 0 002-2v-8a2 2 0 00-2-2h-8a2 2 0 00-2 2v8a2 2 0 002 2z" />
            </svg>
          )}
        </button>
      </div>
    </div>
  );
}
