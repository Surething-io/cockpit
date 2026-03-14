'use client';

import { useState, forwardRef } from 'react';
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

function formatTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  const diffMs = now.getTime() - d.getTime();
  const diffMin = Math.floor(diffMs / 60000);
  if (diffMin < 1) return '刚刚';
  if (diffMin < 60) return `${diffMin}分钟前`;
  const diffHour = Math.floor(diffMin / 60);
  if (diffHour < 24) return `${diffHour}小时前`;
  const diffDay = Math.floor(diffHour / 24);
  if (diffDay < 7) return `${diffDay}天前`;
  return d.toLocaleDateString();
}

export const ReviewCommentCard = forwardRef<HTMLDivElement, Props>(function ReviewCommentCard(
  { comment, isActive, isOwnComment, isAdmin, currentAuthorId, canInteract, userNameMap, onClick, onDelete, onEdit, onToggleClosed, onAddReply, onDeleteReply, onEditReply },
  ref
) {
  // 优先用映射表中的最新昵称，fallback 到评论快照中的 author
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

  // 关闭/重开评论：开放时所有人可操作
  const canToggleClosed = isAdmin || isOwnComment || canInteract;

  // 已关闭：折叠为一行
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
        <span className="text-[10px] text-muted-foreground/50 flex-shrink-0">已关闭</span>
        {canToggleClosed && (
          <button
            onClick={e => { e.stopPropagation(); onToggleClosed(false); }}
            className="text-[10px] text-muted-foreground hover:text-foreground transition-colors flex-shrink-0"
            title="重新开放"
          >
            重开
          </button>
        )}
        {(isOwnComment && canInteract || isAdmin) && (
          <button
            onClick={e => { e.stopPropagation(); onDelete(); }}
            className="text-[10px] text-muted-foreground hover:text-red-500 transition-colors flex-shrink-0"
            title="删除评论"
          >
            删除
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
                title="关闭评论"
              >
                关闭
              </button>
            )}
            {isOwnComment && canInteract && (
              <button
                onClick={e => { e.stopPropagation(); handleStartEditComment(); }}
                className="text-[10px] text-muted-foreground hover:text-foreground transition-colors"
                title="编辑评论"
              >
                编辑
              </button>
            )}
            {(isOwnComment && canInteract || isAdmin) && (
              <button
                onClick={e => { e.stopPropagation(); onDelete(); }}
                className="text-[10px] text-muted-foreground hover:text-red-500 transition-colors"
                title="删除评论"
              >
                删除
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
                取消
              </button>
              <button
                onClick={handleSubmitEditComment}
                disabled={!editCommentContent.trim()}
                className="px-2 py-0.5 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
              >
                保存
              </button>
            </div>
          </div>
        ) : (
          <div className="text-sm whitespace-pre-wrap">
            {comment.content}
            {comment.edited && <span className="text-[10px] text-muted-foreground ml-1">(已编辑)</span>}
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
                        title="编辑回复"
                      >
                        编辑
                      </button>
                    )}
                    <button
                      onClick={e => { e.stopPropagation(); onDeleteReply(reply.id); }}
                      className="text-[10px] text-muted-foreground hover:text-red-500 transition-colors"
                      title="删除回复"
                    >
                      删除
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
                      取消
                    </button>
                    <button
                      onClick={handleSubmitEditReply}
                      disabled={!editReplyContent.trim()}
                      className="px-2 py-0.5 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
                    >
                      保存
                    </button>
                  </div>
                </div>
              ) : (
                <div className="text-sm mt-0.5 pl-6 whitespace-pre-wrap">
                  {reply.content}
                  {reply.edited && <span className="text-[10px] text-muted-foreground ml-1">(已编辑)</span>}
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
              回复
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
              placeholder="添加回复..."
              className="w-full px-2 py-1 text-sm bg-secondary border border-border rounded resize-none focus:outline-none focus:border-brand"
              rows={2}
              autoFocus
            />
            <div className="flex items-center justify-end gap-1 mt-1">
              <button
                onClick={() => setShowReplyInput(false)}
                className="px-2 py-0.5 text-xs rounded hover:bg-accent transition-colors text-muted-foreground"
              >
                取消
              </button>
              <button
                onClick={handleSubmitReply}
                disabled={!replyContent.trim()}
                className="px-2 py-0.5 text-xs rounded bg-brand text-white hover:bg-brand/90 transition-colors disabled:opacity-40"
              >
                回复
              </button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
