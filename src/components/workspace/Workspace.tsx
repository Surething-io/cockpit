'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { ProjectSidebar, ProjectInfo } from './ProjectSidebar';
import { EmptyState } from './EmptyState';
import { SessionBrowser } from '../shared/SessionBrowser';
import { SettingsModal } from '../shared/SettingsModal';
import { TokenStatsModal } from '../shared/TokenStatsModal';
import { NoteModal } from '../shared/NoteModal';
import { SessionCompleteToastContainer, showSessionCompleteToast } from './SessionCompleteToast';

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
  const [isTokenStatsOpen, setIsTokenStatsOpen] = useState(false);
  const [isNoteOpen, setIsNoteOpen] = useState(false);
  const [noteProjectCwd, setNoteProjectCwd] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  // 懒加载：只渲染曾被激活过的项目 iframe（只增不减）
  const [loadedCwds, setLoadedCwds] = useState<Set<string>>(new Set());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // 待发送给 iframe 的 sessionId + switchToAgent 标记
  const pendingSessionIdsRef = useRef<Map<string, { sessionId: string; switchToAgent?: boolean }>>(new Map());
  // 跟踪每个项目当前的 sessionId（用于更新 URL，不用于 iframe src）
  const projectSessionIdsRef = useRef<Map<string, string>>(new Map());
  // 截图前保存的项目索引，截图完成后恢复
  const preScreenshotIndexRef = useRef<number | null>(null);

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

  // 当 activeIndex 变化时，将对应项目加入已加载集合
  useEffect(() => {
    const cwd = projects[activeIndex]?.cwd;
    if (cwd) {
      setLoadedCwds(prev => prev.has(cwd) ? prev : new Set(prev).add(cwd));
    }
  }, [activeIndex, projects]);

  // 通知各 iframe 可见性变化（隐藏的 iframe 暂停 WebSocket 等资源消耗）
  useEffect(() => {
    for (const [cwd, iframe] of iframeRefs.current.entries()) {
      const isActive = projects[activeIndex]?.cwd === cwd;
      iframe.contentWindow?.postMessage(
        { type: 'IFRAME_VISIBILITY', visible: isActive },
        '*'
      );
    }
  }, [activeIndex, projects]);

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

    // 更新浏览器标签页标题
    const dirName = cwd.split('/').filter(Boolean).pop();
    document.title = dirName ? `Cockpit - ${dirName}` : 'Cockpit';
  }, []);

  // 处理 URL 参数中的 cwd 和 sessionId
  const hasHandledInitialRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hasHandledInitialRef.current || !initialCwd) return;
    hasHandledInitialRef.current = true;

    // 如果有 initialSessionId，记录到待发送列表和跟踪列表
    if (initialSessionId) {
      pendingSessionIdsRef.current.set(initialCwd, { sessionId: initialSessionId });
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
      // 会话完成通知（iframe 内 Chat 完成时直接 postMessage，不走 state.json watch）
      if (event.data?.type === 'SESSION_COMPLETE' && event.data?.cwd && event.data?.sessionId) {
        const { cwd, sessionId, lastUserMessage } = event.data;
        // 非当前可见项目才弹 toast（当前项目用户已经能看到完成状态）
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd !== cwd) {
          const projectName = cwd.split('/').pop() || cwd;
          showSessionCompleteToast({ projectName, message: lastUserMessage, cwd, sessionId });
        }
      }
      // 打开 Token 统计
      if (event.data?.type === 'OPEN_TOKEN_STATS') {
        setIsTokenStatsOpen(true);
      }
      // 打开项目笔记
      if (event.data?.type === 'OPEN_NOTE' && event.data?.cwd) {
        const cwd = event.data.cwd;
        setNoteProjectCwd(cwd);
        setIsNoteOpen(true);
      }
      // 截图准备：保存当前项目索引，切到目标项目
      if (event.data?.type === 'SCREENSHOT_PREPARE' && event.data?.cwd) {
        preScreenshotIndexRef.current = activeIndex;
        // 复用 OPEN_PROJECT 的逻辑来切换项目
        const cwd = event.data.cwd;
        const existingIndex = projects.findIndex(p => p.cwd === cwd);
        if (existingIndex >= 0 && existingIndex !== activeIndex) {
          setActiveIndex(existingIndex);
        }
        return;
      }
      // 截图完成：恢复之前的项目
      if (event.data?.type === 'SCREENSHOT_DONE') {
        if (preScreenshotIndexRef.current !== null && preScreenshotIndexRef.current !== activeIndex) {
          setActiveIndex(preScreenshotIndexRef.current);
        }
        preScreenshotIndexRef.current = null;
        return;
      }
      // iframe 内请求打开/切换项目（worktree 切换、session 打开等）
      if (event.data?.type === 'OPEN_PROJECT' && event.data?.cwd) {
        const { cwd, sessionId } = event.data;
        const targetSessionId = sessionId || '';
        projectSessionIdsRef.current.set(cwd, targetSessionId);

        const existingIndex = projects.findIndex(p => p.cwd === cwd);
        if (existingIndex >= 0) {
          // 项目已存在，切换到该 iframe
          if (targetSessionId) {
            const iframe = iframeRefs.current.get(cwd);
            if (iframe?.contentWindow) {
              iframe.contentWindow.postMessage({ type: 'SWITCH_SESSION', sessionId: targetSessionId }, '*');
            }
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
          if (targetSessionId) {
            pendingSessionIdsRef.current.set(cwd, { sessionId: targetSessionId });
          }
        }
        updateUrl(cwd, targetSessionId);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projects, activeIndex, collapsed, updateUrl, saveProjects]);

  // 选择项目
  const handleSelectProject = useCallback((index: number) => {
    setActiveIndex(index);
    saveProjects(projects, index, collapsed);
    const selectedProject = projects[index];
    if (selectedProject?.cwd) {
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
          switchToAgent: true,
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
      pendingSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
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
          switchToAgent: true,
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
      pendingSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
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
    const pending = pendingSessionIdsRef.current.get(cwd);
    if (pending) {
      const iframe = iframeRefs.current.get(cwd);
      if (iframe?.contentWindow) {
        iframe.contentWindow.postMessage({
          type: 'SWITCH_SESSION',
          sessionId: pending.sessionId,
          switchToAgent: pending.switchToAgent,
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
    <div className="h-screen flex bg-background overflow-hidden">
      {/* 左侧项目列表 */}
      <ProjectSidebar
        projects={projects}
        activeIndex={activeIndex}
        collapsed={collapsed}
        currentCwd={projects[activeIndex]?.cwd}
        onSelectProject={handleSelectProject}
        onRemoveProject={handleRemoveProject}
        onReorderProjects={handleReorderProjects}
        onToggleCollapse={handleToggleCollapse}
        onOpenSessionBrowser={() => setIsSessionBrowserOpen(true)}
        onOpenSettings={() => setIsSettingsOpen(true)}
        onOpenNote={(cwd) => { setNoteProjectCwd(cwd ?? null); setIsNoteOpen(true); }}
        onSwitchProject={handleSwitchProject}
      />

      {/* 右侧内容区域 */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {projects.length === 0 ? (
          // 空状态：显示所有会话列表
          <EmptyState onSelectSession={handleAddProject} />
        ) : (
          // 项目 iframe 容器（懒加载：只渲染曾被激活过的项目）
          <div className="flex-1 relative overflow-hidden">
            {projects.map((project, index) => (
              loadedCwds.has(project.cwd) && (
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
              )
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

      {/* Token Stats Modal */}
      <TokenStatsModal
        isOpen={isTokenStatsOpen}
        onClose={() => setIsTokenStatsOpen(false)}
      />

      {/* Note Modal */}
      <NoteModal
        isOpen={isNoteOpen}
        onClose={() => { setIsNoteOpen(false); setNoteProjectCwd(null); }}
        projectCwd={noteProjectCwd}
        projectName={noteProjectCwd ? noteProjectCwd.split('/').pop() : null}
      />

      {/* 左下角会话完成通知 */}
      <SessionCompleteToastContainer onNavigate={handleSwitchProject} />
    </div>
  );
}
