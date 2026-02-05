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

interface WorkspaceProps {
  initialCwd?: string;
  initialSessionId?: string;
}

export function Workspace({ initialCwd, initialSessionId }: WorkspaceProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isLoaded, setIsLoaded] = useState(false);
  const [unreadProjects, setUnreadProjects] = useState<Set<string>>(new Set());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // 待发送给 iframe 的 sessionId（iframe 加载完成后发送 SWITCH_SESSION）
  const pendingSessionIdsRef = useRef<Map<string, string>>(new Map());
  // 跟踪每个项目当前的 sessionId（用于更新 URL，不用于 iframe src）
  const projectSessionIdsRef = useRef<Map<string, string>>(new Map());

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

  // 更新 URL 地址栏的工具函数
  const updateUrl = useCallback((cwd: string, sessionId?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('cwd', cwd);
    if (sessionId) {
      url.searchParams.set('sessionId', sessionId);
    } else {
      url.searchParams.delete('sessionId');
    }
    window.history.replaceState({}, '', url.toString());
  }, []);

  // 处理 URL 参数中的 cwd 和 sessionId
  const hasHandledInitialRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hasHandledInitialRef.current || !initialCwd) return;
    hasHandledInitialRef.current = true;

    // 如果有 initialSessionId，记录到待发送列表和跟踪列表
    if (initialSessionId) {
      pendingSessionIdsRef.current.set(initialCwd, initialSessionId);
      projectSessionIdsRef.current.set(initialCwd, initialSessionId);
    }

    // 检查项目是否已存在
    const existingIndex = projects.findIndex(p => p.cwd === initialCwd);

    if (existingIndex >= 0) {
      // 项目已存在，切换到该项目
      if (existingIndex !== activeIndex) {
        setActiveIndex(existingIndex);
        saveProjects(projects, existingIndex, collapsed);
      }
    } else {
      // 新项目，添加到列表
      const newProject: ProjectInfo = { cwd: initialCwd };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
    }

    // 更新 URL
    updateUrl(initialCwd, initialSessionId);
  }, [isLoaded, initialCwd, initialSessionId, projects, activeIndex, collapsed, saveProjects, updateUrl]);

  // 监听 iframe 发来的消息
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // 会话完成通知
      if (event.data?.type === 'SESSION_COMPLETE' && event.data?.cwd) {
        const completedCwd = event.data.cwd;
        // 如果不是当前活跃项目，添加到未读列表
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd !== completedCwd) {
          setUnreadProjects(prev => new Set(prev).add(completedCwd));
        }
      }
      // sessionId 变化通知（iframe 内切换 tab）
      if (event.data?.type === 'SESSION_CHANGE' && event.data?.cwd && event.data?.sessionId) {
        const { cwd, sessionId } = event.data;
        // 记录该项目的当前 sessionId
        projectSessionIdsRef.current.set(cwd, sessionId);
        // 如果是当前活跃项目，更新 URL
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd === cwd) {
          updateUrl(cwd, sessionId);
        }
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projects, activeIndex, updateUrl]);

  // 选择项目
  const handleSelectProject = useCallback((index: number) => {
    setActiveIndex(index);
    saveProjects(projects, index, collapsed);
    // 清除该项目的未读状态，并更新 URL
    const selectedProject = projects[index];
    if (selectedProject?.cwd) {
      setUnreadProjects(prev => {
        const next = new Set(prev);
        next.delete(selectedProject.cwd);
        return next;
      });
      // 更新 URL（使用跟踪的 sessionId）
      const sessionId = projectSessionIdsRef.current.get(selectedProject.cwd);
      updateUrl(selectedProject.cwd, sessionId);
    }
  }, [projects, collapsed, saveProjects, updateUrl]);

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
    // 跟踪 sessionId
    projectSessionIdsRef.current.set(cwd, sessionId);

    // 检查是否已存在该项目
    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // 已存在，通知 iframe 切换 session
      const iframe = iframeRefs.current.get(cwd);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'SWITCH_SESSION',
          sessionId,
        }, '*');
      }
      setActiveIndex(existingIndex);
      saveProjects(projects, existingIndex, collapsed);
    } else {
      // 新项目，添加到列表末尾
      const newProject: ProjectInfo = { cwd };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
      // 记录待发送的 sessionId（iframe 加载后发送）
      pendingSessionIdsRef.current.set(cwd, sessionId);
    }

    // 更新 URL
    updateUrl(cwd, sessionId);
    // 关闭 SessionBrowser
    setIsSessionBrowserOpen(false);
  }, [projects, collapsed, saveProjects, updateUrl]);

  // 切换项目/会话（从 GlobalSessionMonitor 调用）
  const handleSwitchProject = useCallback((cwd: string, sessionId: string) => {
    // 跟踪 sessionId
    projectSessionIdsRef.current.set(cwd, sessionId);

    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // 项目已存在，通知 iframe 切换 session
      const iframe = iframeRefs.current.get(cwd);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'SWITCH_SESSION',
          sessionId,
        }, '*');
      }
      if (existingIndex !== activeIndex) {
        setActiveIndex(existingIndex);
        saveProjects(projects, existingIndex, collapsed);
      }
    } else {
      // 新项目，添加到列表
      const newProject: ProjectInfo = { cwd };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
      // 记录待发送的 sessionId（iframe 加载后发送）
      pendingSessionIdsRef.current.set(cwd, sessionId);
    }

    // 更新 URL
    updateUrl(cwd, sessionId);
  }, [projects, activeIndex, collapsed, saveProjects, updateUrl]);

  // 构建 iframe URL（只包含 cwd，sessionId 由 iframe 内部管理）
  const getProjectUrl = (project: ProjectInfo) => {
    return `/project?cwd=${encodeURIComponent(project.cwd)}`;
  };

  // iframe 加载完成后，发送待发送的 sessionId
  const handleIframeLoad = useCallback((cwd: string) => {
    const pendingSessionId = pendingSessionIdsRef.current.get(cwd);
    if (pendingSessionId) {
      const iframe = iframeRefs.current.get(cwd);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'SWITCH_SESSION',
          sessionId: pendingSessionId,
        }, '*');
      }
      pendingSessionIdsRef.current.delete(cwd);
    }
  }, []);

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
                onLoad={() => handleIframeLoad(project.cwd)}
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
