'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { ProjectSidebar, ProjectInfo } from './ProjectSidebar';
import { EmptyState } from './EmptyState';
import { SessionBrowser } from './SessionBrowser';
import { SettingsModal } from './SettingsModal';
import { HtmlAppsModal, type HtmlAppPreview } from '@cockpit/feature-explorer';
import { TokenStatsModal } from '@cockpit/feature-agent';
import { NoteModal } from './NoteModal';
import { SkillsModal } from '@cockpit/feature-skills';
import { SessionCompleteToastContainer, showSessionCompleteToast } from '@cockpit/feature-agent';
import { useEffectQuery } from '@cockpit/effect-react';
import { fetchProjects, saveProjects as saveProjectsEffect } from './effect/projectClient';

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
  const [isSkillsOpen, setIsSkillsOpen] = useState(false);
  const [isHtmlAppsOpen, setIsHtmlAppsOpen] = useState(false);
  const [htmlAppPreviews, setHtmlAppPreviews] = useState<HtmlAppPreview[]>([]);
  const [activeHtmlAppPreviewPath, setActiveHtmlAppPreviewPath] = useState<string | null>(null);
  const [isLoaded, setIsLoaded] = useState(false);
  // Lazy load: only render project iframes that have been activated before (ever-growing set)
  const [loadedCwds, setLoadedCwds] = useState<Set<string>>(new Set());
  const iframeRefs = useRef<Map<string, HTMLIFrameElement>>(new Map());
  // Initial session (and view intent) for a project, frozen at the moment the project
  // is first added. Read by getProjectUrl to build the iframe src, so the selected
  // sessionId reaches useTabState deterministically via the URL instead of a racy
  // post-onLoad postMessage. Never mutated after birth (mutating it would change the
  // iframe src and force a full reload), so later in-iframe session switches don't touch it.
  const initialSessionIdsRef = useRef<Map<string, { sessionId: string; switchToAgent?: boolean }>>(new Map());
  // Track the current sessionId per project (used for URL updates, not iframe src)
  const projectSessionIdsRef = useRef<Map<string, string>>(new Map());
  // Project index saved before screenshot; restored when screenshot completes
  const preScreenshotIndexRef = useRef<number | null>(null);

  // useEffectQuery interrupts the Fiber on unmount (equivalent to AbortController) and
  // funnels all errors into AppError.
  const projectsQuery = useEffectQuery(fetchProjects, []);

  // Mirror the Effect result into local state; render layer stays in plain React.
  useEffect(() => {
    if (projectsQuery.status === 'success') {
      const data = projectsQuery.data;
      setProjects([...(data.projects || [])]);
      setActiveIndex(data.activeIndex || 0);
      setCollapsed(data.collapsed || false);
      setIsLoaded(true);
    } else if (projectsQuery.status === 'error') {
      console.error('Failed to load projects:', projectsQuery.error);
      setIsLoaded(true);
    }
  }, [projectsQuery]);

  // Save project list — fire-and-forget; failures only logged.
  const saveProjects = useCallback(
    async (
      newProjects: ProjectInfo[],
      newActiveIndex: number,
      newCollapsed: boolean,
    ) => {
      const { Effect } = await import('effect');
      const { BrowserRuntime } = await import('@cockpit/effect-runtime');
      const exit = await BrowserRuntime.runPromise(
        saveProjectsEffect({
          projects: newProjects,
          activeIndex: newActiveIndex,
          collapsed: newCollapsed,
        }).pipe(Effect.either)
      );
      if (exit._tag === 'Left') {
        console.error('Failed to save projects:', exit.left);
      }
    },
    []
  );

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

  // (Initial load moved to useEffectQuery + sync useEffect above)

  const handleOpenHtmlApp = useCallback((path: string) => {
    const cwd = projects[activeIndex]?.cwd;
    const iframe = cwd ? iframeRefs.current.get(cwd) : null;
    const targetWindow = iframe?.contentWindow;
    if (!targetWindow) return;
    const event = targetWindow.document.createEvent('CustomEvent');
    event.initCustomEvent('console-open-browser', false, false, { url: path });
    targetWindow.dispatchEvent(event);
  }, [activeIndex, projects]);

  const handleShowHtmlAppPreview = useCallback((item: HtmlAppPreview) => {
    setHtmlAppPreviews((prev) => (
      prev.some((preview) => preview.path === item.path) ? prev : [...prev, item]
    ));
    setActiveHtmlAppPreviewPath(item.path);
  }, []);

  const handleMinimizeHtmlAppPreview = useCallback(() => {
    setActiveHtmlAppPreviewPath(null);
  }, []);

  const handleCloseHtmlAppPreview = useCallback((path: string) => {
    setHtmlAppPreviews((prev) => prev.filter((item) => item.path !== path));
    setActiveHtmlAppPreviewPath((current) => (current === path ? null : current));
  }, []);

  // Ask mounted project frames for their live tab order when the recent-session
  // dropdown opens. Reading session.json here can lag behind a drag reorder;
  // the in-memory tab arrays are authoritative for the numbers currently shown.
  const resolveSessionNumbers = useCallback((): Promise<Record<string, string>> => {
    const requestId = crypto.randomUUID();
    const projectNumbers = new Map(projects.map((project, index) => [project.cwd, index + 1]));
    const frames = [...iframeRefs.current.values()];
    if (frames.length === 0) return Promise.resolve({});

    return new Promise((resolve) => {
      const numbers: Record<string, string> = {};
      const pending = new Set(frames.map((frame) => frame.contentWindow).filter(Boolean));
      const finish = () => {
        window.removeEventListener('message', handleMessage);
        clearTimeout(timeoutId);
        resolve(numbers);
      };
      const handleMessage = (event: MessageEvent) => {
        if (event.data?.type !== 'SESSION_NUMBERS' || event.data?.requestId !== requestId) return;
        if (!pending.delete(event.source as Window)) return;
        const projectNumber = projectNumbers.get(event.data.cwd);
        if (projectNumber && Array.isArray(event.data.sessionIds)) {
          event.data.sessionIds.forEach((sessionId: unknown, index: number) => {
            if (typeof sessionId === 'string') {
              numbers[`${event.data.cwd}\n${sessionId}`] = `${projectNumber}.${index + 1}`;
            }
          });
        }
        if (pending.size === 0) finish();
      };
      window.addEventListener('message', handleMessage);
      const timeoutId = window.setTimeout(finish, 300);
      frames.forEach((frame) => frame.contentWindow?.postMessage({ type: 'GET_SESSION_NUMBERS', requestId }, '*'));
    });
  }, [projects]);

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

    // Update the browser tab title. Project name only — an installed PWA window
    // already gets the app name from manifest `name`, so prefixing "Cockpit"
    // here would render as "OpenCockpit - Cockpit - <project>".
    const dirName = cwd.split('/').filter(Boolean).pop();
    document.title = dirName || 'Cockpit';
  }, []);

  // Handle cwd and sessionId from URL parameters
  const hasHandledInitialRef = useRef(false);
  useEffect(() => {
    if (!isLoaded || hasHandledInitialRef.current || !initialCwd) return;
    hasHandledInitialRef.current = true;

    // If initialSessionId is provided, freeze it for the iframe URL and track it
    if (initialSessionId) {
      initialSessionIdsRef.current.set(initialCwd, { sessionId: initialSessionId });
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
            } else {
              // Project is in the list but its iframe was never mounted (lazy load):
              // postMessage would hit nothing and the first mount would default to the
              // most recent session. Freeze the sessionId for the URL so getProjectUrl
              // carries it on mount via the deterministic initialSessionId path.
              initialSessionIdsRef.current.set(cwd, { sessionId: targetSessionId });
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
            initialSessionIdsRef.current.set(cwd, { sessionId: targetSessionId });
          }
        }
        updateUrl(cwd, targetSessionId);
      }
    };

    window.addEventListener('message', handleMessage);
    return () => window.removeEventListener('message', handleMessage);
  }, [projects, activeIndex, collapsed, updateUrl, saveProjects]);

  // Parent-window keyboard safety net.
  // iframes don't bubble keydown to the parent window, so the per-panel
  // listeners inside TabManager / FileBrowserModal don't run when focus is in
  // the left ProjectSidebar or one of the parent-window modals
  // (SessionBrowser / SettingsModal / NoteModal / SkillsModal / TokenStatsModal).
  // Without this, Cmd+P pops the browser print dialog, Cmd+S triggers "Save
  // Page As...", Cmd+F shows the native find bar, etc. We swallow them at the
  // parent root as a no-op; any parent-window component that wants to react
  // to these keys can still register its own listener and run alongside.
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey) return;
      // Cmd/Ctrl + P / F / S (no Shift) — block browser defaults.
      if (!e.shiftKey && (e.key === 'p' || e.key === 'f' || e.key === 's')) {
        e.preventDefault();
        return;
      }
      // Ctrl+- / Ctrl+Shift+- — keep parity with the in-iframe behavior
      // (intercepted everywhere; no action at the parent level).
      if (e.ctrlKey && !e.metaKey && e.code === 'Minus') {
        e.preventDefault();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, []);

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
      } else {
        // Project is in the list but its iframe was never mounted (lazy load):
        // freeze the sessionId (+ agent view intent) for the iframe URL so the
        // first mount opens the requested session instead of the most recent one.
        initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
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
      // Freeze the selected sessionId (+ agent view intent) for the iframe URL
      initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
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
      } else {
        // Project is in the list but its iframe was never mounted (lazy load):
        // freeze the sessionId (+ agent view intent) for the iframe URL so the
        // first mount opens the requested session instead of the most recent one.
        initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
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
      // Freeze the selected sessionId (+ agent view intent) for the iframe URL
      initialSessionIdsRef.current.set(cwd, { sessionId, switchToAgent: true });
    }

    // Update URL
    updateUrl(cwd, sessionId);
  }, [projects, activeIndex, collapsed, saveProjects, updateUrl]);

  // Build iframe URL. For a project opened with a specific session, carry the sessionId
  // (and, when the open intent was "jump into a session", view=agent) in the URL so that
  // useTabState inside the iframe activates it deterministically on mount. The value is
  // read from initialSessionIdsRef, which is frozen at project birth, so the src string is
  // stable across re-renders (in-iframe session switches never change it → no iframe reload).
  const getProjectUrl = (project: ProjectInfo) => {
    let url = `/project?cwd=${encodeURIComponent(project.cwd)}`;
    const initial = initialSessionIdsRef.current.get(project.cwd);
    if (initial?.sessionId) {
      url += `&sessionId=${encodeURIComponent(initial.sessionId)}`;
      if (initial.switchToAgent) {
        url += `&view=agent`;
      }
    }
    return url;
  };

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
        onOpenSkills={() => setIsSkillsOpen(true)}
        onOpenApps={() => setIsHtmlAppsOpen(true)}
        htmlAppPreviews={htmlAppPreviews}
        activeHtmlAppPreviewPath={activeHtmlAppPreviewPath}
        onShowHtmlAppPreview={handleShowHtmlAppPreview}
        onSwitchProject={handleSwitchProject}
        onResolveSessionNumbers={resolveSessionNumbers}
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

      {/* Skills Modal */}
      <SkillsModal
        isOpen={isSkillsOpen}
        onClose={() => setIsSkillsOpen(false)}
      />

      {/* HTML Apps Modal */}
      <HtmlAppsModal
        isOpen={isHtmlAppsOpen}
        htmlAppPreviews={htmlAppPreviews}
        activeHtmlAppPreviewPath={activeHtmlAppPreviewPath}
        onShowHtmlAppPreview={handleShowHtmlAppPreview}
        onMinimizeHtmlAppPreview={handleMinimizeHtmlAppPreview}
        onCloseHtmlAppPreview={handleCloseHtmlAppPreview}
        onClose={() => setIsHtmlAppsOpen(false)}
        onOpenApp={handleOpenHtmlApp}
      />

      {/* Bottom-left session complete notification */}
      <SessionCompleteToastContainer onNavigate={handleSwitchProject} />
    </div>
  );
}
