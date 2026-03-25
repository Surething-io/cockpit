'use client';

import { useState } from 'react';
import { useTranslation } from 'react-i18next';

interface ProjectItemProps {
  index: number;
  name: string;
  cwd: string;
  isActive: boolean;
  collapsed: boolean;
  hasUnread?: boolean;
  isLoading?: boolean;
  onClick: () => void;
  onRemove: () => void;
  onOpenNote?: () => void;
}

// Numbered SVG icon component
function NumberIcon({ number, isActive }: { number: number; isActive: boolean }) {
  return (
    <svg
      className={`w-6 h-6 flex-shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <rect x="3" y="3" width="18" height="18" rx="4" />
      <text
        x="12"
        y="16"
        textAnchor="middle"
        fill="currentColor"
        stroke="none"
        fontSize="12"
        fontWeight="500"
      >
        {number}
      </text>
    </svg>
  );
}

export function ProjectItem({
  index,
  name,
  cwd,
  isActive,
  collapsed,
  hasUnread,
  isLoading,
  onClick,
  onRemove,
  onOpenNote,
}: ProjectItemProps) {
  const { t } = useTranslation();
  const [isHovered, setIsHovered] = useState(false);

  return (
    <div
      className={`flex items-center gap-2 px-2 py-1 rounded-lg cursor-pointer transition-colors relative ${
        collapsed ? 'justify-center' : ''
      } ${
        isActive
          ? 'bg-accent text-foreground'
          : 'text-muted-foreground hover:bg-secondary hover:text-foreground'
      }`}
      onClick={onClick}
      onMouseEnter={() => setIsHovered(true)}
      onMouseLeave={() => setIsHovered(false)}
      title={cwd}
    >
      <div className="relative flex-shrink-0">
        <NumberIcon number={index + 1} isActive={isActive} />
        {/* Unread red dot - top-right of number icon (hidden while loading to avoid overlap) */}
        {hasUnread && !isActive && !isLoading && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
        )}
        {/* Running orange dot - top-right of number icon */}
        {isLoading && (
          <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-orange-9 animate-pulse" />
        )}
      </div>

      {!collapsed && (
        <>
          <span className="flex-1 truncate text-sm">{name}</span>

          {/* Status indicator: active (brand color), loading dot moved to top-right of number */}
          {!isLoading && isActive ? (
            <span className="w-2 h-2 rounded-full bg-brand flex-shrink-0" />
          ) : null}
        </>
      )}

      {/* Action buttons - shown on hover in expanded state */}
      {isHovered && !collapsed && (
        <div className="absolute right-1 top-1/2 -translate-y-1/2 flex items-center gap-0.5">
          {/* Note button */}
          {onOpenNote && (
            <button
              className="p-1 rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
              onClick={(e) => {
                e.stopPropagation();
                onOpenNote();
              }}
              title={t('workspace.projectNotes')}
            >
              <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M11 5H6a2 2 0 00-2 2v11a2 2 0 002 2h11a2 2 0 002-2v-5m-1.414-9.414a2 2 0 112.828 2.828L11.828 15H9v-2.828l8.586-8.586z" />
              </svg>
            </button>
          )}
          {/* Close button */}
          <button
            className="p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-colors"
            onClick={(e) => {
              e.stopPropagation();
              onRemove();
            }}
            title={t('workspace.closeProject')}
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>
      )}
    </div>
  );
}
