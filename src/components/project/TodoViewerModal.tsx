'use client';

import { useEffect } from 'react';
import { Portal } from '../shared/Portal';
import { X, Circle, Loader, CheckCircle2 } from 'lucide-react';
import type { ToolCallInfo } from '@/types/chat';

interface TodoItem {
  content: string;
  status: 'pending' | 'in_progress' | 'completed';
  activeForm: string;
}

interface TodoViewerModalProps {
  toolCall: ToolCallInfo;
  onClose: () => void;
}

function StatusIcon({ status }: { status: TodoItem['status'] }) {
  switch (status) {
    case 'completed':
      return <CheckCircle2 className="w-4 h-4 text-green-500 flex-shrink-0" />;
    case 'in_progress':
      return <Loader className="w-4 h-4 text-brand flex-shrink-0 animate-spin" />;
    default:
      return <Circle className="w-4 h-4 text-muted-foreground flex-shrink-0" />;
  }
}

export function TodoViewerModal({ toolCall, onClose }: TodoViewerModalProps) {
  const todos = (toolCall.input?.todos as TodoItem[]) || [];

  // ESC 关闭
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  const completed = todos.filter(t => t.status === 'completed').length;
  const total = todos.length;

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-lg shadow-xl w-full max-w-6xl flex flex-col transition-all"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <div className="flex items-center gap-3">
            <h3 className="text-sm font-medium text-foreground">任务列表</h3>
            <span className="text-xs text-muted-foreground">
              {completed} / {total} 完成
            </span>
          </div>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* Progress bar */}
        <div className="px-4 pt-3">
          <div className="h-1.5 bg-secondary rounded-full overflow-hidden">
            <div
              className="h-full bg-green-500 rounded-full transition-all duration-300"
              style={{ width: `${total > 0 ? (completed / total) * 100 : 0}%` }}
            />
          </div>
        </div>

        {/* Todo list */}
        <div className="px-4 py-3 space-y-1 max-h-[60vh] overflow-y-auto">
          {todos.map((todo, i) => (
            <div
              key={i}
              className={`flex items-start gap-2.5 px-3 py-2 rounded-lg transition-colors ${
                todo.status === 'in_progress'
                  ? 'bg-brand/5'
                  : todo.status === 'completed'
                    ? 'opacity-60'
                    : ''
              }`}
            >
              <div className="mt-0.5">
                <StatusIcon status={todo.status} />
              </div>
              <div className="min-w-0 flex-1">
                <div className={`text-sm ${
                  todo.status === 'completed' ? 'line-through text-muted-foreground' : 'text-foreground'
                }`}>
                  {todo.content}
                </div>
                {todo.status === 'in_progress' && todo.activeForm && (
                  <div className="text-xs text-brand mt-0.5">{todo.activeForm}</div>
                )}
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}
