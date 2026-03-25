'use client';

import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Portal } from '../shared/Portal';
import { ChatMessage } from '@/types/chat';

interface UserMessagesModalProps {
  isOpen: boolean;
  onClose: () => void;
  messages: ChatMessage[];
  onSelectMessage: (messageId: string) => void;
}

// Parse timestamp from message.id (format: user-{timestamp})
function parseTimestamp(messageId: string): number | null {
  const match = messageId.match(/^user-(\d+)/);
  if (match) {
    return parseInt(match[1], 10);
  }
  return null;
}

// Format timestamp to human-readable format
function formatTime(timestamp: number): string {
  const date = new Date(timestamp);
  const now = new Date();
  const isToday = date.toDateString() === now.toDateString();

  if (isToday) {
    return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
  }

  // If not today, show date and time
  return date.toLocaleDateString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  });
}

// Truncate message content
function truncateContent(content: string, maxLength: number = 50): string {
  // Remove extra whitespace and newlines
  const cleaned = content.replace(/\s+/g, ' ').trim();
  if (cleaned.length <= maxLength) {
    return cleaned;
  }
  return cleaned.slice(0, maxLength) + '...';
}

export function UserMessagesModal({ isOpen, onClose, messages, onSelectMessage }: UserMessagesModalProps) {
  const { t } = useTranslation();

  // ESC key to close
  useEffect(() => {
    if (!isOpen) return;

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  if (!isOpen) return null;

  // Filter user messages
  const userMessages = messages.filter(m => m.role === 'user');

  const handleSelect = (messageId: string) => {
    onSelectMessage(messageId);
    onClose();
  };

  const modalContent = (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4"
      onClick={onClose}
    >
      <div
        className="bg-card rounded-lg shadow-xl w-full max-w-lg max-h-[70vh] flex flex-col"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border shrink-0">
          <h3 className="text-sm font-medium text-foreground">{t('userMessages.title')}</h3>
          <button
            onClick={onClose}
            className="p-1 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto">
          {userMessages.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-muted-foreground">
              {t('userMessages.noMessages')}
            </div>
          ) : (
            <div className="divide-y divide-border">
              {userMessages.map((message, index) => {
                const timestamp = parseTimestamp(message.id);
                const timeStr = timestamp ? formatTime(timestamp) : '';

                return (
                  <button
                    key={message.id}
                    onClick={() => handleSelect(message.id)}
                    className="w-full px-4 py-3 text-left hover:bg-accent transition-colors"
                  >
                    <div className="flex items-start gap-3">
                      {/* Index */}
                      <span className="text-xs text-muted-foreground font-mono w-6 shrink-0 pt-0.5">
                        {index + 1}.
                      </span>
                      {/* Content */}
                      <div className="flex-1 min-w-0">
                        <p className="text-sm text-foreground break-words">
                          {truncateContent(message.content)}
                        </p>
                      </div>
                      {/* Time */}
                      {timeStr && (
                        <span className="text-xs text-muted-foreground shrink-0 pt-0.5">
                          {timeStr}
                        </span>
                      )}
                    </div>
                  </button>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );

  return <Portal>{modalContent}</Portal>;
}
