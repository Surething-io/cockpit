'use client';

import { useState } from 'react';

interface ProjectItemProps {
  index: number;
  name: string;
  cwd: string;
  isActive: boolean;
  collapsed: boolean;
  hasUnread?: boolean;
  onClick: () => void;
  onRemove: () => void;
}

// 数字 SVG 图标组件
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
  onClick,
  onRemove,
}: ProjectItemProps) {
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
        {/* 未读红点 - 仅在非活跃且有未读时显示 */}
        {hasUnread && !isActive && (
          <span className="absolute -top-0.5 -left-0.5 w-2 h-2 rounded-full bg-red-500" />
        )}
      </div>

      {!collapsed && (
        <>
          <span className="flex-1 truncate text-sm">{name}</span>

          {/* 活跃指示器 */}
          {isActive && (
            <span className="w-2 h-2 rounded-full bg-brand flex-shrink-0" />
          )}
        </>
      )}

      {/* 关闭按钮 - 展开状态悬停时显示 */}
      {isHovered && !collapsed && (
        <button
          className="absolute right-1 top-1/2 -translate-y-1/2 p-1 rounded hover:bg-red-500/20 text-muted-foreground hover:text-red-500 transition-colors"
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
          title="关闭项目"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
          </svg>
        </button>
      )}
    </div>
  );
}
