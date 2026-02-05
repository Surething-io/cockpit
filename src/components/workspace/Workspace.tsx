'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ProjectSidebar, ProjectInfo } from './ProjectSidebar';
import { EmptyState } from './EmptyState';
import { SessionBrowser } from '../shared/SessionBrowser';
import { SettingsModal } from '../shared/SettingsModal';

interface ProjectsData {
  projects: ProjectInfo[];
  activeIndex: number;
  collapsed: boolean;
}

export function Workspace() {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [unreadProjects, setUnreadProjects] = useState<Set<string>>(new Set());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());

  // 加载项目列表
  const loadProjects = useCallback(async () => {
    try {
      const response = await fetch('/api/projects');
      if (response.ok) {
        const data: ProjectsData = await response.json();
        setProjects(data.projects || []);
        setActiveIndex(data.activeIndex || 0);
        setCollapsed(data.collapsed || false);
      }
    } catch (error) {
      console.error('Failed to load projects:', error);
    } finally {
      setIsLoaded(true);
    }
  }, []);

  // 保存项目列表
  const saveProjects = useCallback(async (newProjects: ProjectInfo[], newActiveIndex: number, newCollapsed: boolean) => {
    try {
      await fetch('/api/projects', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          projects: newProjects,
          activeIndex: newActiveIndex,
          collapsed: newCollapsed,
        }),
      });
    } catch (error) {
      console.error('Failed to save projects:', error);
    }
  }, []);

  // 初始化加载
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // 监听 iframe 发来的 SESSION_COMPLETE 消息
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      if (event.data?.type === 'SESSION_COMPLETE' && event.data?.cwd) {
        const completedCwd = event.data.cwd;
        // 如果不是当前活跃项目，添加到未读列表
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd !== completedCwd) {
          setUnreadProjects(prev => new Set(prev).add(completedCwd));
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projects, activeIndex]);

  // 选择项目
  const handleSelectProject = useCallback((index: number) => {
    setActiveIndex(index);
    saveProjects(projects, index, collapsed);
    // 清除该项目的未读状态
    const selectedCwd = projects[index]?.cwd;
    if (selectedCwd) {
      setUnreadProjects(prev => {
        const next = new Set(prev);
        next.delete(selectedCwd);
        return next;
      });
    }
  }, [projects, collapsed, saveProjects]);

  // 移除项目
  const handleRemoveProject = useCallback((index: number) => {
    const newProjects = projects.filter((_, i) => i !== index);
    let newActiveIndex = activeIndex;

    // 调整 activeIndex
    if (index < activeIndex) {
      newActiveIndex = activeIndex - 1;
    } else if (index === activeIndex && newActiveIndex >= newProjects.length) {
      newActiveIndex = Math.max(0, newProjects.length - 1);
    }

    setProjects(newProjects);
    setActiveIndex(newActiveIndex);
    saveProjects(newProjects, newActiveIndex, collapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // 重新排序项目
  const handleReorderProjects = useCallback((newProjects: ProjectInfo[]) => {
    // 找到当前活跃项目在新数组中的位置
    const currentProject = projects[activeIndex];
    const newActiveIndex = newProjects.findIndex(p => p.cwd === currentProject?.cwd);

    setProjects(newProjects);
    setActiveIndex(newActiveIndex >= 0 ? newActiveIndex : 0);
    saveProjects(newProjects, newActiveIndex >= 0 ? newActiveIndex : 0, collapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // 切换折叠
  const handleToggleCollapse = useCallback(() => {
    const newCollapsed = !collapsed;
    setCollapsed(newCollapsed);
    saveProjects(projects, activeIndex, newCollapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // 添加项目（从 SessionBrowser 或 EmptyState 选择）
  const handleAddProject = useCallback((cwd: string, sessionId: string) => {
    // 检查是否已存在该项目
    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // 已存在，更新 sessionId 并切换到该项目
      const newProjects = [...projects];
      newProjects[existingIndex] = { ...newProjects[existingIndex], sessionId };
      setProjects(newProjects);
      setActiveIndex(existingIndex);
      saveProjects(newProjects, existingIndex, collapsed);
    } else {
      // 新项目，添加到列表末尾
      const newProject: ProjectInfo = { cwd, sessionId };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
    }

    // 关闭 SessionBrowser
    setIsSessionBrowserOpen(false);
  }, [projects, collapsed, saveProjects]);

  // 切换项目/会话（从 GlobalSessionMonitor 调用）
  const handleSwitchProject = useCallback((cwd: string, sessionId: string) => {
    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // 项目已存在
      if (existingIndex === activeIndex) {
        // 同一个项目，通知 iframe 切换 session
        const iframe = iframeRefs.current.get(cwd);
        if (iframe?.contentWindow) {
          iframe.contentWindow.postMessage({
            type: 'SWITCH_SESSION',
            sessionId,
          }, '*');
        }
      } else {
        // 不同项目，切换到该项目
        setActiveIndex(existingIndex);
        saveProjects(projects, existingIndex, collapsed);
      }
    } else {
      // 新项目，添加到列表
      const newProject: ProjectInfo = { cwd, sessionId };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
    }
  }, [projects, activeIndex, collapsed, saveProjects]);

  // 构建 iframe URL
  const getProjectUrl = (project: ProjectInfo) => {
    const params = new URLSearchParams();
    params.set('cwd', project.cwd);
    if (project.sessionId) {
      params.set('sessionId', project.sessionId);
    }
    return `/project?${params.toString()}`;
  };

  // 等待加载完成
  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-card">
        <div className="flex items-center gap-2 text-muted-foreground">
          <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>加载中...</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background">
      {/* 左侧项目列表 */}
      <ProjectSidebar
        projects={projects}
        activeIndex={activeIndex}
        collapsed={collapsed}
        currentCwd={projects[activeIndex]?.cwd}
        unreadProjects={unreadProjects}
        onSelectProject={handleSelectProject}
        onRemoveProject={handleRemoveProject}
        onReorderProjects={handleReorderProjects}
        onToggleCollapse={handleToggleCollapse}
        onOpenSessionBrowser={() => setIsSessionBrowserOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onSwitchProject={handleSwitchProject}
      />

      {/* 右侧内容区域 */}
      <div className="flex-1 flex flex-col min-w-0">
        {projects.length === 0 ? (
          // 空状态：显示所有会话列表
          <EmptyState onSelectSession={handleAddProject} />
        ) : (
          // 项目 iframe 容器
          <div className="flex-1 relative">
            {projects.map((project, index) => (
              <iframe
                key={project.cwd}
                ref={(el) => {
                  if (el) {
                    iframeRefs.current.set(project.cwd, el);
                  } else {
                    iframeRefs.current.delete(project.cwd);
                  }
                }}
                src={getProjectUrl(project)}
                className={`absolute inset-0 w-full h-full border-0 ${
                  index === activeIndex ? 'block' : 'hidden'
                }`}
                title={`Project: ${project.cwd}`}
              />
            ))}
          </div>
        )}
      </div>

      {/* SessionBrowser Modal */}
      <SessionBrowser
        isOpen={isSessionBrowserOpen}
        onClose={() => setIsSessionBrowserOpen(false)}
        onSelectSession={handleAddProject}
      />

      {/* Settings Modal */}
      <SettingsModal
        isOpen={isSettingsOpen}
        onClose={() => setIsSettingsOpen(false)}
      />
    </div>
  );
}
