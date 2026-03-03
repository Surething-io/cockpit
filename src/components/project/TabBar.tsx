'use client';

import React from 'react';
import { TabInfo } from './useTabState';
import { Tooltip } from '../shared/Tooltip';

// ============================================
// Tab 圆圈编号图标组件
// ============================================

function TabNumberIcon({ number, isActive }: { number: number; isActive: boolean }) {
  return (
    <svg
      className={`w-5 h-5 flex-shrink-0 ${isActive ? 'text-brand' : 'text-muted-foreground'}`}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
    >
      <circle cx="12" cy="12" r="9" />
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

// ============================================
// TabBar
// ============================================

interface TabBarProps {
  tabs: TabInfo[];
  activeTabId: string;
  unreadTabs: Set<string>;
  dragTabIndex: number | null;
  dragOverTabIndex: number | null;
  isPinned?: (tabId: string) => boolean;
  onTogglePin?: (tabId: string) => void;
  onSwitchTab: (tabId: string) => void;
  onCloseTab: (tabId: string) => void;
  onNewTab: () => void;
  onDragStart: (index: number) => void;
  onDragOver: (e: React.DragEvent, index: number) => void;
  onDrop: (index: number) => void;
  onDragEnd: () => void;
}

export function TabBar({
  tabs,
  activeTabId,
  unreadTabs,
  dragTabIndex,
  dragOverTabIndex,
  isPinned,
  onTogglePin,
  onSwitchTab,
  onCloseTab,
  onNewTab,
  onDragStart,
  onDragOver,
  onDrop,
  onDragEnd,
}: TabBarProps) {
  return (
    <div className="border-b border-border bg-card shrink-0">
      <div className="flex items-center px-2 gap-1 overflow-x-auto">
        {tabs.map((tab, index) => (
          <Tooltip key={tab.id} content={tab.title} delay={200}>
            <div
              draggable
              onDragStart={() => onDragStart(index)}
              onDragOver={(e) => onDragOver(e, index)}
              onDrop={() => onDrop(index)}
              onDragEnd={onDragEnd}
              className={`group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer rounded-t-lg transition-colors ${
                tab.id === activeTabId
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-secondary'
              } ${dragTabIndex === index ? 'opacity-50' : ''} ${
                dragOverTabIndex === index ? 'border-l-2 border-brand' : ''
              }`}
              onClick={() => onSwitchTab(tab.id)}
            >
              {/* 圆圈编号 + 状态角标（右上角） */}
              <div className="relative flex-shrink-0">
                <TabNumberIcon number={index + 1} isActive={tab.id === activeTabId} />
                {/* Loading 黄点闪烁 - 右上角 */}
                {tab.isLoading && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-green-9 animate-pulse" />
                )}
                {/* 未读红点角标 - 右上角（loading 时不显示，避免重叠） */}
                {!tab.isLoading && unreadTabs.has(tab.id) && tab.id !== activeTabId && (
                  <span className="absolute -top-0.5 -right-0.5 w-2 h-2 rounded-full bg-red-500" />
                )}
                {/* 图钉角标 - 右上角（不与 loading/unread 重叠时显示） */}
                {onTogglePin && isPinned?.(tab.id) && !tab.isLoading && !(unreadTabs.has(tab.id) && tab.id !== activeTabId) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(tab.id);
                    }}
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center rounded-full bg-card text-amber-500 hover:text-destructive transition-colors"
                    title="取消固定"
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="currentColor">
                      <path d="M16 4h-2V2h-4v2H8c-.55 0-1 .45-1 1v4l-2 3v2h5.97v7l1 1 1-1v-7H19v-2l-2-3V5c0-.55-.45-1-1-1z" />
                    </svg>
                  </button>
                )}
                {/* 未 pin 时 hover 显示图钉 - 右上角 */}
                {onTogglePin && !isPinned?.(tab.id) && !tab.isLoading && !(unreadTabs.has(tab.id) && tab.id !== activeTabId) && (
                  <button
                    onClick={(e) => {
                      e.stopPropagation();
                      onTogglePin(tab.id);
                    }}
                    className="absolute -top-1 -right-1 w-3.5 h-3.5 flex items-center justify-center rounded-full bg-card text-muted-foreground opacity-0 group-hover:opacity-60 hover:!opacity-100 hover:!text-brand transition-all"
                    title="固定到常用会话"
                  >
                    <svg className="w-2.5 h-2.5" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2.5}>
                      <path d="M16 4h-2V2h-4v2H8c-.55 0-1 .45-1 1v4l-2 3v2h5.97v7l1 1 1-1v-7H19v-2l-2-3V5c0-.55-.45-1-1-1z" />
                    </svg>
                  </button>
                )}
              </div>
              <span className="max-w-32 truncate">{tab.title}</span>
              {tabs.length > 1 && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    onCloseTab(tab.id);
                  }}
                  className="ml-1 p-0.5 rounded hover:bg-muted opacity-0 group-hover:opacity-100 transition-opacity"
                  title="关闭标签"
                >
                  <svg className="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
                  </svg>
                </button>
              )}
            </div>
          </Tooltip>
        ))}
        {/* 新建标签按钮 */}
        <button
          onClick={onNewTab}
          className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
          title="新建标签"
        >
          <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
          </svg>
        </button>
      </div>
    </div>
  );
}
