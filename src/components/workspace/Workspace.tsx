'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
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
  const { t } = useTranslation();
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [activeIndex, setActiveIndex] = useState(0);
  const [collapsed, setCollapsed] = useState(false);
  const [isSessionBrowserOpen, setIsSessionBrowserOpen] = useState(false);
  const [isSettingsOpen, setIsSettingsOpen] = useState(false);
  const [isTokenStatsOpen, setIsTokenStatsOpen] = useState(false);
  const [isNoteOpen, setIsNoteOpen] = useState(false);
  const [noteProjectCwd, setNoteProjectCwd] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  // Lazy load: only render project iframes that have been activated before (ever-growing set)
  const [loadedCwds, setLoadedCwds] = useState<Set<string>>(new Set());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // Pending sessionId + switchToAgent flag to send to iframe after load
  const pendingSessionIdsRef = useRef<Map<string, { sessionId: string; switchToAgent?: boolean }>>(new Map());
  // Track the current sessionId per project (used for URL updates, not iframe src)
  const projectSessionIdsRef = useRef<Map<string, string>>(new Map());
  // Project index saved before screenshot; restored when screenshot completes
  const preScreenshotIndexRef = useRef<number | null>(null);

  // Load project list
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

  // Save project list
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

  // When activeIndex changes, add the corresponding project to the loaded set
  useEffect(() => {
    const cwd = projects[activeIndex]?.cwd;
    if (cwd) {
      setLoadedCwds(prev => prev.has(cwd) ? prev : new Set(prev).add(cwd));
    }
  }, [activeIndex, projects]);

  // Notify iframes of visibility changes (hidden iframes pause WebSocket and other resource-intensive operations)
  useEffect(() => {
    for (const [cwd, iframe] of iframeRefs.current.entries()) {
      const isActive = projects[activeIndex]?.cwd === cwd;
      iframe.contentWindow?.postMessage(
        { type: 'IFRAME_VISIBILITY', visible: isActive },
        '*'
      );
    }
  }, [activeIndex, projects]);

  // Initial load
  useEffect(() => {
    loadProjects();
  }, [loadProjects]);

  // Utility function to update the browser address bar URL
  const updateUrl = useCallback((cwd: string, sessionId?: string) => {
    const url = new URL(window.location.href);
    url.searchParams.set('cwd', cwd);
    if (sessionId) {
      url.searchParams.set('sessionId', sessionId);
    } else {
      url.searchParams.delete('sessionId');
    }
    window.history.replaceState({}, '', url.toString());

    // Update the browser tab title
    const dirName = cwd.split('/').filter(Boolean).pop();
    document.title = dirName ? `Cockpit - ${dirName}` : 'Cockpit';
  }, []);

  // Handle cwd and sessionId from URL parameters
  const hasHandledInitialRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hasHandledInitialRef.current || !initialCwd) return;
    hasHandledInitialRef.current = true;

    // If initialSessionId is provided, record it in the pending send list and tracking map
    if (initialSessionId) {
      pendingSessionIdsRef.current.set(initialCwd, { sessionId: initialSessionId });
      projectSessionIdsRef.current.set(initialCwd, initialSessionId);
    }

    // Check if the project already exists
    const existingIndex = projects.findIndex(p => p.cwd === initialCwd);

    if (existingIndex >= 0) {
      // Project already exists, switch to it
      if (existingIndex !== activeIndex) {
        setActiveIndex(existingIndex);
        saveProjects(projects, existingIndex, collapsed);
      }
    } else {
      // New project, add to list
      const newProject: ProjectInfo = { cwd: initialCwd };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
    }

    // Update URL
    updateUrl(initialCwd, initialSessionId);
  }, [isLoaded, initialCwd, initialSessionId, projects, activeIndex, collapsed, saveProjects, updateUrl]);

  // Listen for messages from iframes
  useEffect(() => {
    const handleMessage = (event: MessageEvent) => {
      // Session ID change notification (tab switch inside iframe)
      if (event.data?.type === 'SESSION_CHANGE' && event.data?.cwd && event.data?.sessionId) {
        const { cwd, sessionId } = event.data;
        // Record the current sessionId for this project
        projectSessionIdsRef.current.set(cwd, sessionId);
        // If this is the currently active project, update the URL
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd === cwd) {
          updateUrl(cwd, sessionId);
        }
      }
      // Session complete notification (posted directly via postMessage when Chat completes, bypasses state.json watch)
      if (event.data?.type === 'SESSION_COMPLETE' && event.data?.cwd && event.data?.sessionId) {
        const { cwd, sessionId, lastUserMessage } = event.data;
        // Only show toast for projects other than the currently visible one (the user can already see the completion state for the active project)
        const currentProject = projects[activeIndex];
        if (currentProject?.cwd !== cwd) {
          const projectName = cwd.split('/').pop() || cwd;
          showSessionCompleteToast({ projectName, message: lastUserMessage, cwd, sessionId });
        }
      }
      // Open token stats
      if (event.data?.type === 'OPEN_TOKEN_STATS') {
        setIsTokenStatsOpen(true);
      }
      // Open project notes
      if (event.data?.type === 'OPEN_NOTE' && event.data?.cwd) {
        const cwd = event.data.cwd;
        setNoteProjectCwd(cwd);
        setIsNoteOpen(true);
      }
      // Screenshot preparation: save current project index, switch to target project
      if (event.data?.type === 'SCREENSHOT_PREPARE' && event.data?.cwd) {
        preScreenshotIndexRef.current = activeIndex;
        // Reuse OPEN_PROJECT logic to switch projects
        const cwd = event.data.cwd;
        const existingIndex = projects.findIndex(p => p.cwd === cwd);
        if (existingIndex >= 0 && existingIndex !== activeIndex) {
          setActiveIndex(existingIndex);
        }
        return;
      }
      // Screenshot complete: restore the previous project
      if (event.data?.type === 'SCREENSHOT_DONE') {
        if (preScreenshotIndexRef.current !== null && preScreenshotIndexRef.current !== activeIndex) {
          setActiveIndex(preScreenshotIndexRef.current);
        }
        preScreenshotIndexRef.current = null;
        return;
      }
      // Request from inside an iframe to open or switch a project (worktree switch, session open, etc.)
      if (event.data?.type === 'OPEN_PROJECT' && event.data?.cwd) {
        const { cwd, sessionId } = event.data;
        const targetSessionId = sessionId || '';
        projectSessionIdsRef.current.set(cwd, targetSessionId);

        const existingIndex = projects.findIndex(p => p.cwd === cwd);
        if (existingIndex >= 0) {
          // Project already exists, switch to its iframe
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
          // New project, add to list
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

  // Select project
  const handleSelectProject = useCallback((index: number) => {
    setActiveIndex(index);
    saveProjects(projects, index, collapsed);
    const selectedProject = projects[index];
    if (selectedProject?.cwd) {
      // Update URL (using the tracked sessionId)
      const sessionId = projectSessionIdsRef.current.get(selectedProject.cwd);
      updateUrl(selectedProject.cwd, sessionId);
    }
  }, [projects, collapsed, saveProjects, updateUrl]);

  // Remove project
  const handleRemoveProject = useCallback((index: number) => {
    const newProjects = projects.filter((_, i) => i !== index);
    let newActiveIndex = activeIndex;

    // Adjust activeIndex
    if (index < activeIndex) {
      newActiveIndex = activeIndex - 1;
    } else if (index === activeIndex && newActiveIndex >= newProjects.length) {
      newActiveIndex = Math.max(0, newProjects.length - 1);
    }

    setProjects(newProjects);
    setActiveIndex(newActiveIndex);
    saveProjects(newProjects, newActiveIndex, collapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // Reorder projects
  const handleReorderProjects = useCallback((newProjects: ProjectInfo[]) => {
    // Find the position of the currently active project in the new array
    const currentProject = projects[activeIndex];
    const newActiveIndex = newProjects.findIndex(p => p.cwd === currentProject?.cwd);

    setProjects(newProjects);
    setActiveIndex(newActiveIndex >= 0 ? newActiveIndex : 0);
    saveProjects(newProjects, newActiveIndex >= 0 ? newActiveIndex : 0, collapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // Toggle collapse
  const handleToggleCollapse = useCallback(() => {
    const newCollapsed = !collapsed;
    setCollapsed(newCollapsed);
    saveProjects(projects, activeIndex, newCollapsed);
  }, [projects, activeIndex, collapsed, saveProjects]);

  // Add project (selected from SessionBrowser or EmptyState)
  const handleAddProject = useCallback((cwd: string, sessionId: string) => {
    // Track sessionId
    projectSessionIdsRef.current.set(cwd, sessionId);

    // Check if the project already exists
    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // Already exists, notify iframe to switch session
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
      // New project, append to list
      const newProject: ProjectInfo = { cwd };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
      // Record pending sessionId to send after iframe loads
      pendingSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
    }

    // Update URL
    updateUrl(cwd, sessionId);
    // Close SessionBrowser
    setIsSessionBrowserOpen(false);
  }, [projects, collapsed, saveProjects, updateUrl]);

  // Switch project/session (called from GlobalSessionMonitor)
  const handleSwitchProject = useCallback((cwd: string, sessionId: string) => {
    // Track sessionId
    projectSessionIdsRef.current.set(cwd, sessionId);

    const existingIndex = projects.findIndex(p => p.cwd === cwd);

    if (existingIndex >= 0) {
      // Project already exists, notify iframe to switch session
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
      // New project, add to list
      const newProject: ProjectInfo = { cwd };
      const newProjects = [...projects, newProject];
      const newActiveIndex = newProjects.length - 1;
      setProjects(newProjects);
      setActiveIndex(newActiveIndex);
      saveProjects(newProjects, newActiveIndex, collapsed);
      // Record pending sessionId to send after iframe loads
      pendingSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
    }

    // Update URL
    updateUrl(cwd, sessionId);
  }, [projects, activeIndex, collapsed, saveProjects, updateUrl]);

  // Build iframe URL (contains only cwd; sessionId is managed inside the iframe)
  const getProjectUrl = (project: ProjectInfo) => {
    return `/project?cwd=${encodeURIComponent(project.cwd)}`;
  };

  // After iframe finishes loading, send the pending sessionId
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

  // Wait for initial load to complete
  if (!isLoaded) {
    return (
      <div className="h-screen flex items-center justify-center bg-card">
        <div className="flex items-center gap-2 text-muted-foreground">
          <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
            <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
            <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
          </svg>
          <span>{t('workspace.loadingText')}</span>
        </div>
      </div>
    );
  }

  return (
    <div className="h-screen flex bg-background overflow-hidden">
      {/* Left project list */}
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
        onAddProject={(cwd) => {
          const existingIndex = projects.findIndex(p => p.cwd === cwd);
          if (existingIndex >= 0) {
            setActiveIndex(existingIndex);
            saveProjects(projects, existingIndex, collapsed);
          } else {
            const newProjects = [...projects, { cwd }];
            const newActiveIndex = newProjects.length - 1;
            setProjects(newProjects);
            setActiveIndex(newActiveIndex);
            saveProjects(newProjects, newActiveIndex, collapsed);
          }
        }}
      />

      {/* Right content area */}
      <div className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {projects.length === 0 ? (
          // Empty state: show all session list
          <EmptyState onSelectSession={handleAddProject} />
        ) : (
          // Project iframe container (lazy load: only render projects that have been activated)
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
        onAddProject={(cwd) => {
          const existingIndex = projects.findIndex(p => p.cwd === cwd);
          if (existingIndex >= 0) {
            setActiveIndex(existingIndex);
            saveProjects(projects, existingIndex, collapsed);
          } else {
            const newProjects = [...projects, { cwd }];
            const newActiveIndex = newProjects.length - 1;
            setProjects(newProjects);
            setActiveIndex(newActiveIndex);
            saveProjects(newProjects, newActiveIndex, collapsed);
          }
          setIsSessionBrowserOpen(false);
        }}
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

      {/* Bottom-left session complete notification */}
      <SessionCompleteToastContainer onNavigate={handleSwitchProject} />
    </div>
  );
}
