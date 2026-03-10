'use client';

import { useRef, useEffect, useCallback, MutableRefObject } from 'react';
import { ReviewCommentCard } from './ReviewCommentCard';
import { ReviewComment } from '@/lib/review-utils';

interface Props {
  comments: ReviewComment[];
  activeCommentId: string | null;
  currentAuthorId: string;
  isActive: boolean;
  onCommentClick: (commentId: string) => void;
  onDeleteComment: (commentId: string) => void;
  onEditComment: (commentId: string, content: string) => void;
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
  onCommentClick,
  onDeleteComment,
  onEditComment,
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
      <div className="px-4 py-2 bg-secondary border-b border-border flex-shrink-0">
        <span className="text-xs text-muted-foreground">
          {comments.length === 0 ? '选中左侧文本添加评论' : `${comments.length} 条评论`}
        </span>
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
                currentAuthorId={currentAuthorId}
                canInteract={isActive}
                onClick={() => onCommentClick(comment.id)}
                onDelete={() => onDeleteComment(comment.id)}
                onEdit={(content) => onEditComment(comment.id, content)}
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
