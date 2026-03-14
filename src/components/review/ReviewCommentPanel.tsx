'use client';

import { useRef, useEffect, useCallback, MutableRefObject } from 'react';
import { ReviewCommentCard } from './ReviewCommentCard';
import { ReviewComment } from '@/lib/review-utils';
import type { UserNameMap } from './ReviewCommentsListModal';

interface Props {
  comments: ReviewComment[];
  activeCommentId: string | null;
  currentAuthorId: string;
  isActive: boolean;
  isAdmin?: boolean;
  userNameMap: UserNameMap;
  onCommentClick: (commentId: string) => void;
  onNavigateComment: (direction: 'prev' | 'next') => void;
  onDeleteComment: (commentId: string) => void;
  onEditComment: (commentId: string, content: string) => void;
  onToggleCommentClosed: (commentId: string, closed: boolean) => void;
  onAddReply: (commentId: string, content: string) => void;
  onDeleteReply: (commentId: string, replyId: string) => void;
  onEditReply: (commentId: string, replyId: string, content: string) => void;
  scrollToCommentRef: MutableRefObject<((commentId: string) => void) | undefined>;
}

export function ReviewCommentPanel({
  comments,
  activeCommentId,
  currentAuthorId,
  isActive,
  isAdmin,
  userNameMap,
  onCommentClick,
  onNavigateComment,
  onDeleteComment,
  onEditComment,
  onToggleCommentClosed,
  onAddReply,
  onDeleteReply,
  onEditReply,
  scrollToCommentRef,
}: Props) {
  const commentRefs = useRef<Map<string, HTMLDivElement>>(new Map());
  const containerRef = useRef<HTMLDivElement>(null);

  // Expose scroll function to parent
  const scrollToComment = useCallback((commentId: string) => {
    const el = commentRefs.current.get(commentId);
    if (el) {
      el.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }
  }, []);

  useEffect(() => {
    scrollToCommentRef.current = scrollToComment;
  }, [scrollToComment, scrollToCommentRef]);

  // Sort comments by position in document
  const sortedComments = [...comments].sort((a, b) => a.anchor.startOffset - b.anchor.startOffset);

  return (
    <div ref={containerRef} className="h-full flex flex-col bg-card">
      <div className="px-4 py-2 bg-secondary border-b border-border flex-shrink-0 flex items-center">
        <span className="text-xs text-muted-foreground">
          {comments.length === 0
            ? '选中左侧文本添加评论'
            : activeCommentId
              ? `${sortedComments.findIndex(c => c.id === activeCommentId) + 1}/${comments.length} 条评论`
              : `${comments.length} 条评论`}
        </span>
        {comments.length > 0 && (
          <div className="flex items-center gap-1 ml-2">
            <button
              onClick={() => onNavigateComment('prev')}
              className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors flex items-center gap-0.5"
              title="上一条"
            >
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="15 18 9 12 15 6"/></svg>
              上一条
            </button>
            <button
              onClick={() => onNavigateComment('next')}
              className="px-1.5 py-0.5 text-[11px] text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors flex items-center gap-0.5"
              title="下一条"
            >
              下一条
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
          </div>
        )}
      </div>

      <div className="flex-1 overflow-auto">
        {sortedComments.length === 0 ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            <div className="text-center">
              <div className="text-2xl mb-2">💬</div>
              <div>选中左侧文本即可添加评论</div>
            </div>
          </div>
        ) : (
          <div className="p-3 space-y-3">
            {sortedComments.map(comment => (
              <ReviewCommentCard
                key={comment.id}
                ref={el => {
                  if (el) commentRefs.current.set(comment.id, el);
                  else commentRefs.current.delete(comment.id);
                }}
                comment={comment}
                isActive={comment.id === activeCommentId}
                isOwnComment={comment.authorId === currentAuthorId}
                isAdmin={isAdmin}
                currentAuthorId={currentAuthorId}
                canInteract={isActive}
                userNameMap={userNameMap}
                onClick={() => onCommentClick(comment.id)}
                onDelete={() => onDeleteComment(comment.id)}
                onEdit={(content) => onEditComment(comment.id, content)}
                onToggleClosed={(closed) => onToggleCommentClosed(comment.id, closed)}
                onAddReply={(content) => onAddReply(comment.id, content)}
                onDeleteReply={(replyId) => onDeleteReply(comment.id, replyId)}
                onEditReply={(replyId, content) => onEditReply(comment.id, replyId, content)}
              />
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
