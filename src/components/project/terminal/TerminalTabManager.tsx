'use client';

import { useState, useCallback, useEffect } from 'react';
import { TerminalView } from './TerminalView';
import { Plus } from 'lucide-react';

// Tab 圆圈编号图标组件
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

interface TerminalTab {
  id: string;
  name: string;
  cwd: string;
}

interface TerminalTabManagerProps {
  initialCwd: string;
}

export function TerminalTabManager({ initialCwd }: TerminalTabManagerProps) {
  const [tabs, setTabs] = useState<TerminalTab[]>([]);
  const [activeTabId, setActiveTabId] = useState<string | null>(null);
  const [isInitialized, setIsInitialized] = useState(false);
  const [editingTabId, setEditingTabId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState('');
  const [dragTabIndex, setDragTabIndex] = useState<number | null>(null);
  const [dragOverTabIndex, setDragOverTabIndex] = useState<number | null>(null);

  // 初始化：从文件系统恢复或创建第一个 tab
  useEffect(() => {
    if (isInitialized) return;

    const loadTabs = async () => {
      try {
        const response = await fetch(`/api/terminal/tabs?cwd=${encodeURIComponent(initialCwd)}`);
        if (response.ok) {
          const data = await response.json();
          if (data && data.tabs && Array.isArray(data.tabs) && data.tabs.length > 0) {
            setTabs(data.tabs);
            setActiveTabId(data.activeTabId || data.tabs[0].id);
            setIsInitialized(true);
            return;
          }
        }
      } catch (e) {
        console.error('Failed to restore terminal tabs:', e);
      }

      // 如果没有存储的数据或恢复失败，创建第一个 tab
      const firstTab: TerminalTab = {
        id: `terminal-${Date.now()}`,
        name: 'Terminal 1',
        cwd: initialCwd,
      };
      setTabs([firstTab]);
      setActiveTabId(firstTab.id);
      setIsInitialized(true);
    };

    loadTabs();
  }, [initialCwd, isInitialized]);

  // 持久化 tab 状态到文件系统
  useEffect(() => {
    if (!isInitialized || tabs.length === 0) return;

    const saveTabs = async () => {
      try {
        await fetch('/api/terminal/tabs', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            cwd: initialCwd,
            tabs,
            activeTabId,
          }),
        });
      } catch (e) {
        console.error('Failed to save terminal tabs:', e);
      }
    };

    saveTabs();
  }, [tabs, activeTabId, isInitialized, initialCwd]);

  // 新建 tab
  const handleNewTab = useCallback(() => {
    const newTab: TerminalTab = {
      id: `terminal-${Date.now()}`,
      name: `Terminal ${tabs.length + 1}`,
      cwd: initialCwd,
    };
    setTabs((prev) => [...prev, newTab]);
    setActiveTabId(newTab.id);
  }, [tabs.length, initialCwd]);

  // 关闭 tab（同时清理历史记录和输出文件）
  const handleCloseTab = useCallback((tabId: string) => {
    // 异步清理历史记录（不阻塞 UI）
    fetch(`/api/terminal/history?cwd=${encodeURIComponent(initialCwd)}&tabId=${encodeURIComponent(tabId)}`, {
      method: 'DELETE',
    }).catch(() => {});

    setTabs((prev) => {
      const filtered = prev.filter((tab) => tab.id !== tabId);

      // 如果关闭的是当前激活的 tab，切换到相邻的 tab
      if (tabId === activeTabId) {
        const currentIndex = prev.findIndex((tab) => tab.id === tabId);
        if (filtered.length > 0) {
          const nextIndex = Math.min(currentIndex, filtered.length - 1);
          setActiveTabId(filtered[nextIndex].id);
        } else {
          setActiveTabId(null);
        }
      }

      return filtered;
    });
  }, [activeTabId, initialCwd]);

  // 切换 tab
  const handleTabClick = useCallback((tabId: string) => {
    setActiveTabId(tabId);
  }, []);

  // 重命名 tab
  const handleRenameTab = useCallback((tabId: string, newName: string) => {
    setTabs((prev) =>
      prev.map((tab) => (tab.id === tabId ? { ...tab, name: newName } : tab))
    );
  }, []);

  // 开始编辑 tab 名称
  const handleStartEdit = useCallback((tabId: string, currentName: string) => {
    setEditingTabId(tabId);
    setEditingName(currentName);
  }, []);

  // 完成编辑
  const handleFinishEdit = useCallback(() => {
    if (editingTabId && editingName.trim()) {
      handleRenameTab(editingTabId, editingName.trim());
    }
    setEditingTabId(null);
    setEditingName('');
  }, [editingTabId, editingName, handleRenameTab]);

  // 取消编辑
  const handleCancelEdit = useCallback(() => {
    setEditingTabId(null);
    setEditingName('');
  }, []);

  // 拖拽开始
  const handleDragStart = useCallback((index: number) => {
    setDragTabIndex(index);
  }, []);

  // 拖拽经过
  const handleDragOver = useCallback((e: React.DragEvent, index: number) => {
    e.preventDefault();
    setDragOverTabIndex(index);
  }, []);

  // 拖拽放下
  const handleDrop = useCallback((index: number) => {
    if (dragTabIndex === null || dragTabIndex === index) {
      setDragTabIndex(null);
      setDragOverTabIndex(null);
      return;
    }

    // 重新排序 tabs
    setTabs((prev) => {
      const newTabs = [...prev];
      const [draggedTab] = newTabs.splice(dragTabIndex, 1);
      newTabs.splice(index, 0, draggedTab);
      return newTabs;
    });

    setDragTabIndex(null);
    setDragOverTabIndex(null);
  }, [dragTabIndex]);

  // 拖拽结束
  const handleDragEnd = useCallback(() => {
    setDragTabIndex(null);
    setDragOverTabIndex(null);
  }, []);

  // 获取当前激活的 tab
  const activeTab = tabs.find((tab) => tab.id === activeTabId);

  // 键盘快捷键
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      // Cmd+T: 新建 tab
      if ((e.metaKey || e.ctrlKey) && e.key === 't' && !e.shiftKey && !e.altKey) {
        e.preventDefault();
        handleNewTab();
      }
      // Cmd+W: 关闭当前 tab
      else if ((e.metaKey || e.ctrlKey) && e.key === 'w' && !e.shiftKey && !e.altKey) {
        if (activeTabId && tabs.length > 1) {
          e.preventDefault();
          handleCloseTab(activeTabId);
        }
      }
    };

    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleNewTab, handleCloseTab, activeTabId, tabs.length]);

  return (
    <div className="h-full flex flex-col bg-background">
      {/* Tab 栏 */}
      <div className="border-b border-border bg-card shrink-0">
        <div className="flex items-center px-2 gap-1 overflow-x-auto">
          {tabs.map((tab, index) => (
            <div
              key={tab.id}
              draggable
              onDragStart={() => handleDragStart(index)}
              onDragOver={(e) => handleDragOver(e, index)}
              onDrop={() => handleDrop(index)}
              onDragEnd={handleDragEnd}
              className={`group flex items-center gap-1 px-3 py-1.5 text-sm cursor-pointer rounded-t-lg transition-colors ${
                tab.id === activeTabId
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-secondary'
              } ${dragTabIndex === index ? 'opacity-50' : ''} ${
                dragOverTabIndex === index ? 'border-l-2 border-brand' : ''
              }`}
              onClick={() => handleTabClick(tab.id)}
            >
              {/* 圆圈编号 */}
              <div className="relative flex-shrink-0">
                <TabNumberIcon number={index + 1} isActive={tab.id === activeTabId} />
              </div>

              {/* Tab 名称或编辑框 */}
              {editingTabId === tab.id ? (
                <input
                  type="text"
                  value={editingName}
                  onChange={(e) => setEditingName(e.target.value)}
                  onBlur={handleFinishEdit}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      handleFinishEdit();
                    } else if (e.key === 'Escape') {
                      handleCancelEdit();
                    }
                  }}
                  onClick={(e) => e.stopPropagation()}
                  className="max-w-32 text-sm bg-background border border-brand rounded px-2 py-0.5 focus:outline-none"
                  autoFocus
                />
              ) : (
                <span
                  className="max-w-32 truncate"
                  onDoubleClick={(e) => {
                    e.stopPropagation();
                    handleStartEdit(tab.id, tab.name);
                  }}
                >
                  {tab.name}
                </span>
              )}

              {/* 关闭按钮 */}
              {tabs.length > 1 && editingTabId !== tab.id && (
                <button
                  onClick={(e) => {
                    e.stopPropagation();
                    handleCloseTab(tab.id);
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
          ))}

          {/* 新建 tab 按钮 */}
          <button
            onClick={handleNewTab}
            className="p-1.5 text-muted-foreground hover:text-foreground hover:bg-accent rounded transition-colors"
            title="新建标签"
          >
            <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
            </svg>
          </button>
        </div>
      </div>

      {/* 终端内容区域 */}
      <div className="flex-1 overflow-hidden">
        {tabs.map((tab) => (
          <div
            key={tab.id}
            className="h-full"
            style={{ display: tab.id === activeTabId ? 'block' : 'none' }}
          >
            <TerminalView cwd={tab.cwd} tabId={tab.id} />
          </div>
        ))}
      </div>
    </div>
  );
}
