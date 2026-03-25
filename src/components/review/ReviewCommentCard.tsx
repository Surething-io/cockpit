'use client';

import { useState, forwardRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ReviewComment } from '@/lib/review-utils';
import type { UserNameMap } from './ReviewCommentsListModal';

interface Props {
  comment: ReviewComment;
  isActive: boolean;
  isOwnComment: boolean;
  isAdmin?: boolean;
  currentAuthorId: string;
  canInteract: boolean;
  userNameMap: UserNameMap;
  onClick: () => void;
  onDelete: () => void;
  onEdit: (content: string) => void;
  onToggleClosed: (closed: boolean) => void;
  onAddReply: (content: string) => void;
  onDeleteReply: (replyId: string) => void;
  onEditReply: (replyId: string, content: string) => void;
}

import i18n from '@/lib/i18n';

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return i18n.t('common.justNow');
  if (diffMin < 60) return i18n.t('common.minutesAgo', { count: diffMin });
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return i18n.t('common.hoursAgo', { count: diffHour });
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return i18n.t('common.daysAgo', { count: diffDay });
  return d.toLocaleDateString();
}

export const ReviewCommentCard = forwardRef<HTMLDivElement, Props>(function ReviewCommentCard(
  { comment, isActive, isOwnComment, isAdmin, currentAuthorId, canInteract, userNameMap, onClick, onDelete, onEdit, onToggleClosed, onAddReply, onDeleteReply, onEditReply },
  ref
) {
  const { t } = useTranslation();
  // Prefer latest nickname from the map, fallback to author in comment snapshot
  const resolveAuthor = (authorId: string, fallback: string) => userNameMap[authorId] || fallback;
  const [replyContent, setReplyContent] = useState('');
  const [showReplyInput, setShowReplyInput] = useState(false);
  // Edit comment state
  const [editingComment, setEditingComment] = useState(false);
  const [editCommentContent, setEditCommentContent] = useState('');
  // Edit reply state
  const [editingReplyId, setEditingReplyId] = useState<string | null>(null);
  const [editReplyContent, setEditReplyContent] = useState('');

  const handleSubmitReply = () => {
    const trimmed = replyContent.trim();
    if (!trimmed) return;
    onAddReply(trimmed);
    setReplyContent('');
    setShowReplyInput(false);
  };

  const handleStartEditComment = () => {
    setEditCommentContent(comment.content);
    setEditingComment(true);
  };

  const handleSubmitEditComment = () => {
    const trimmed = editCommentContent.trim();
    if (!trimmed || trimmed === comment.content) {
      setEditingComment(false);
      return;
    }
    onEdit(trimmed);
    setEditingComment(false);
  };

  const handleStartEditReply = (replyId: string, content: string) => {
    setEditReplyContent(content);
    setEditingReplyId(replyId);
  };

  const handleSubmitEditReply = () => {
    if (!editingReplyId) return;
    const trimmed = editReplyContent.trim();
    const reply = comment.replies.find(r => r.id === editingReplyId);
    if (!trimmed || (reply && trimmed === reply.content)) {
      setEditingReplyId(null);
      return;
    }
    onEditReply(editingReplyId, trimmed);
    setEditingReplyId(null);
  };

  const truncatedAnchor = comment.anchor.selectedText.length > 80
    ? comment.anchor.selectedText.slice(0, 77) + '...'
    : comment.anchor.selectedText;

  // Close/reopen comment: all users can act when open
  const canToggleClosed = isAdmin || isOwnComment || canInteract;

  // Closed: collapse to one line
  if (comment.closed) {
    return (
      <div
        ref={ref}
        className="rounded-lg border border-border/50 bg-card/50 opacity-60 hover:opacity-80 transition-all cursor-pointer px-3 py-2 flex items-center gap-2"
        onClick={onClick}
      >
        <span className="w-4 h-4 rounded-full bg-brand/20 text-brand flex items-center justify-center text-[9px] font-bold flex-shrink-0">
          {resolveAuthor(comment.authorId, comment.author).charAt(0)}
        </span>
        <span className="text-xs text-muted-foreground truncate flex-1">{truncatedAnchor}</span>
        <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">{t('review.closedLabel')}</span>
        {canToggleClosed && (
          <button
            onClick={e => { e.stopPropagation(); onToggleClosed(false); }}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            title={t('review.reopenReview')}
          >
            {t('review.reopen')}
          </button>
        )}
        {(isOwnComment && canInteract || isAdmin) && (
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="text-[10px] text-muted-foreground hover:text-red-500 transition-colors flex-shrink-0"
            title={t('review.deleteComment')}
          >
            {t('common.delete')}
          </button>
        )}
      </div>
    );
  }

  return (
    <div
      ref={ref}
      className={`rounded-lg border transition-all cursor-pointer ${
        isActive
          ? 'border-brand bg-brand/5 shadow-sm'
          : 'border-border bg-card hover:border-muted-foreground/30'
      }`}
      onClick={onClick}
    >
      {/* Quoted anchor text */}
      <div className="px-3 pt-3 pb-1">
        <div className="text-xs bg-yellow-500/10 border-l-2 border-yellow-500 px-2 py-1 rounded-r text-muted-foreground truncate">
          {truncatedAnchor}
        </div>
      </div>

      {/* Comment header */}
      <div className="px-3 pt-2 flex items-center gap-2">
        <span className="w-5 h-5 rounded-full bg-brand/20 text-brand flex items-center justify-center text-[10px] font-bold flex-shrink-0">
          {resolveAuthor(comment.authorId, comment.author).charAt(0)}
        </span>
        <span className="text-xs font-medium">{resolveAuthor(comment.authorId, comment.author)}</span>
        <span className="text-[10px] text-muted-foreground">{formatTime(comment.createdAt)}</span>
        <div className="flex-1" />
        {!editingComment && (
          <div className="flex items-center gap-2">
            {canToggleClosed && (
              <button
                onClick={e => { e.stopPropagation(); onToggleClosed(true); }}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                title={t('review.closeComment')}
              >
                {t('review.closeComment')}
              </button>
            )}
            {isOwnComment && canInteract && (
              <button
                onClick={e => { e.stopPropagation(); handleStartEditComment(); }}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                title={t('review.editComment')}
              >
                {t('common.edit')}
              </button>
            )}
            {(isOwnComment && canInteract || isAdmin) && (
              <button
                onClick={e => { e.stopPropagation(); onDelete(); }}
                className="text-[10px] text-muted-foreground hover:text-red-500 transition-colors"
                title={t('review.deleteComment')}
              >
                {t('common.delete')}
              </button>
            )}
          </div>
        )}
      </div>

      {/* Comment content */}
      <div className="px-3 pt-1 pb-2">
        {editingComment ? (
          <div onClick={e => e.stopPropagation()}>
            <textarea
              value={editCommentContent}
              onChange={e => setEditCommentContent(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmitEditComment();
                }
                if (e.key === 'Escape') setEditingComment(false);
              }}
              className="w-full px-2 py-1.5 text-sm bg-secondary border border-border rounded resize-none focus:outline-none focus:border-brand"
              rows={3}
              autoFocus
            />
            <div className="flex items-center justify-end gap-1 mt-1">
              <button
                onClick={() => setEditingComment(false)}
                className="px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSubmitEditComment}
                disabled={!editCommentContent.trim()}
                className="px-2 py-0.5 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
              >
                {t('common.save')}
              </button>
            </div>
          </div>
        ) : (
          <div className="text-sm whitespace-pre-wrap">
            {comment.content}
            {comment.edited && <span className="text-[10px] text-muted-foreground ml-1">{t('review.edited')}</span>}
          </div>
        )}
      </div>

      {/* Replies */}
      {comment.replies.length > 0 && (
        <div className="mx-3 border-t border-border">
          {comment.replies.map(reply => (
            <div key={reply.id} className="py-2 border-b border-border last:border-b-0">
              <div className="flex items-center gap-2">
                <span className="w-4 h-4 rounded-full bg-accent text-muted-foreground flex items-center justify-center text-[9px] font-bold flex-shrink-0">
                  {resolveAuthor(reply.authorId, reply.author).charAt(0)}
                </span>
                <span className="text-xs font-medium">{resolveAuthor(reply.authorId, reply.author)}</span>
                <span className="text-[10px] text-muted-foreground">{formatTime(reply.createdAt)}</span>
                <div className="flex-1" />
                {editingReplyId !== reply.id && (reply.authorId === currentAuthorId && canInteract || isAdmin) && (
                  <div className="flex items-center gap-2">
                    {reply.authorId === currentAuthorId && canInteract && (
                      <button
                        onClick={e => { e.stopPropagation(); handleStartEditReply(reply.id, reply.content); }}
                        className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                        title={t('review.editReply')}
                      >
                        {t('common.edit')}
                      </button>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onDeleteReply(reply.id); }}
                      className="text-[10px] text-muted-foreground hover:text-red-500 transition-colors"
                      title={t('review.deleteReply')}
                    >
                      {t('common.delete')}
                    </button>
                  </div>
                )}
              </div>
              {editingReplyId === reply.id ? (
                <div className="mt-1 pl-6" onClick={e => e.stopPropagation()}>
                  <textarea
                    value={editReplyContent}
                    onChange={e => setEditReplyContent(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                        e.preventDefault();
                        handleSubmitEditReply();
                      }
                      if (e.key === 'Escape') setEditingReplyId(null);
                    }}
                    className="w-full px-2 py-1 text-sm bg-secondary border border-border rounded resize-none focus:outline-none focus:border-brand"
                    rows={2}
                    autoFocus
                  />
                  <div className="flex items-center justify-end gap-1 mt-1">
                    <button
                      onClick={() => setEditingReplyId(null)}
                      className="px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
                    >
                      {t('common.cancel')}
                    </button>
                    <button
                      onClick={handleSubmitEditReply}
                      disabled={!editReplyContent.trim()}
                      className="px-2 py-0.5 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
                    >
                      {t('common.save')}
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-sm mt-0.5 pl-6 whitespace-pre-wrap">
                  {reply.content}
                  {reply.edited && <span className="text-[10px] text-muted-foreground ml-1">{t('review.edited')}</span>}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {/* Reply action / input */}
      <div className="px-3 pb-2 pt-1">
        {!showReplyInput ? (
          canInteract && (
            <button
              onClick={e => { e.stopPropagation(); setShowReplyInput(true); }}
              className="text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              {t('review.reply')}
            </button>
          )
        ) : (
          <div className="mt-1" onClick={e => e.stopPropagation()}>
            <textarea
              value={replyContent}
              onChange={e => setReplyContent(e.target.value)}
              onKeyDown={e => {
                if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
                  e.preventDefault();
                  handleSubmitReply();
                }
                if (e.key === 'Escape') setShowReplyInput(false);
              }}
              placeholder={t('review.replyPlaceholder')}
              className="w-full px-2 py-1 text-sm bg-secondary border border-border rounded resize-none focus:outline-none focus:border-brand"
              rows={2}
              autoFocus
            />
            <div className="flex items-center justify-end gap-1 mt-1">
              <button
                onClick={() => setShowReplyInput(false)}
                className="px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
              >
                {t('common.cancel')}
              </button>
              <button
                onClick={handleSubmitReply}
                disabled={!replyContent.trim()}
                className="px-2 py-0.5 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
              >
                {t('review.reply')}
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
