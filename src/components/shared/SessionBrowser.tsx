'use client';

import { useState, useEffect, useCallback, useRef } from 'react';
import { useTranslation } from 'react-i18next';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
  engine?: 'claude' | 'ollama' | 'codex' | 'kimi';
}

interface ProjectInfo {
  name: string;
  fullPath: string;
  encodedPath: string;
  sessionCount: number;
}

interface ProjectState {
  isExpanded: boolean;
  isLoading: boolean;
  sessions: SessionInfo[];
  error: string | null;
}

interface SessionBrowserProps {
  isOpen: boolean;
  onClose: () => void;
  onSelectSession?: (cwd: string, sessionId: string) => void;
  onAddProject?: (cwd: string) => void;
}

export function SessionBrowser({ isOpen, onClose, onSelectSession, onAddProject }: SessionBrowserProps) {
  const { t } = useTranslation();
  const [isPickingFolder, setIsPickingFolder] = useState(false);
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectStates, setProjectStates] = useState<Record<string, ProjectState>>({});
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Load project list
  const loadProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    setError(null);
    // Reset all project states (collapse all)
    setProjectStates({});
    try {
      const response = await fetch('/api/sessions/projects');
      if (!response.ok) {
        throw new Error('Failed to load projects');
      }
      const data = await response.json();
      setProjects(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Unknown error');
    } finally {
      setIsLoadingProjects(false);
    }
  }, []);

  // Load session list for a specific project
  const loadProjectSessions = useCallback(async (encodedPath: string) => {
    setProjectStates(prev => ({
      ...prev,
      [encodedPath]: {
        ...prev[encodedPath],
        isExpanded: true,
        isLoading: true,
        sessions: [],
        error: null,
      },
    }));

    try {
      const response = await fetch(`/api/sessions/projects/${encodeURIComponent(encodedPath)}`);
      if (!response.ok) {
        throw new Error('Failed to load sessions');
      }
      const sessions = await response.json();
      setProjectStates(prev => ({
        ...prev,
        [encodedPath]: {
          ...prev[encodedPath],
          isLoading: false,
          sessions,
        },
      }));
    } catch (err) {
      setProjectStates(prev => ({
        ...prev,
        [encodedPath]: {
          ...prev[encodedPath],
          isLoading: false,
          error: err instanceof Error ? err.message : 'Unknown error',
        },
      }));
    }
  }, []);

  // Toggle project expand/collapse state
  const toggleProject = useCallback((encodedPath: string) => {
    const currentState = projectStates[encodedPath];

    if (currentState?.isExpanded) {
      // Collapse
      setProjectStates(prev => ({
        ...prev,
        [encodedPath]: {
          ...prev[encodedPath],
          isExpanded: false,
        },
      }));
    } else {
      // Expand and load (if not already loaded)
      if (!currentState?.sessions?.length) {
        loadProjectSessions(encodedPath);
      } else {
        setProjectStates(prev => ({
          ...prev,
          [encodedPath]: {
            ...prev[encodedPath],
            isExpanded: true,
          },
        }));
      }
    }
  }, [projectStates, loadProjectSessions]);

  useEffect(() => {
    if (isOpen) {
      loadProjects();
      // Auto-focus the search input
      setTimeout(() => {
        searchInputRef.current?.focus();
      }, 100);
    }
  }, [isOpen, loadProjects]);

  // Open folder picker
  const handlePickFolder = useCallback(async () => {
    if (isPickingFolder) return;
    setIsPickingFolder(true);
    try {
      const res = await fetch('/api/pick-folder');
      const data = await res.json();
      if (data.folder && onAddProject) {
        onAddProject(data.folder);
        onClose();
      }
    } catch {
      // Ignore errors
    } finally {
      setIsPickingFolder(false);
    }
  }, [isPickingFolder, onAddProject, onClose]);

  // Close on ESC key
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && isOpen) {
        onClose();
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, onClose]);

  const handleSessionClick = (cwd: string, sessionPath: string) => {
    // Extract sessionId from sessionPath (filename without .jsonl)
    const fileName = sessionPath.split('/').pop() || '';
    const sessionId = fileName.replace('.jsonl', '');

    // Use onSelectSession callback if provided; otherwise notify parent Workspace to open
    if (onSelectSession) {
      onSelectSession(cwd, sessionId);
    } else {
      window.parent.postMessage({
        type: 'OPEN_PROJECT',
        cwd,
        sessionId,
      }, '*');
    }
  };

  const formatDate = (isoString: string) => {
    const date = new Date(isoString);
    return date.toLocaleString('zh-CN', {
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  };

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-6xl h-[90vh] mx-4 bg-card rounded-lg shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border">
          <h2 className="text-sm font-medium text-foreground">
            {t('sessions.projectList')}
          </h2>
          <div className="flex items-center gap-3">
            <input
              ref={searchInputRef}
              type="text"
              placeholder={t('workspace.searchProjectPath')}
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className="px-2 py-1 text-xs border border-border rounded bg-card text-foreground placeholder-slate-9 focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
            />
            {onAddProject && (
              <button
                onClick={handlePickFolder}
                disabled={isPickingFolder}
                className="flex items-center gap-1.5 px-2.5 py-1 text-xs rounded-md border border-border text-muted-foreground hover:text-foreground hover:bg-accent transition-colors disabled:opacity-50"
                title={t('sessions.openFolder')}
              >
                <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                  <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m3-3H9m-4 7h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2v10a2 2 0 002 2z" />
                </svg>
                {isPickingFolder ? t('sessions.selectingFolder') : t('sessions.openFolder')}
              </button>
            )}
            <button
              onClick={onClose}
              className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
            >
              <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
              </svg>
            </button>
          </div>
        </div>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4">
          {isLoadingProjects && (
            <div className="flex items-center justify-center h-full">
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                  <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                  <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                </svg>
                <span>{t('workspace.loadingProjects')}</span>
              </div>
            </div>
          )}

          {error && (
            <div className="flex items-center justify-center h-full">
              <div className="text-xs text-red-11">{error}</div>
            </div>
          )}

          {!isLoadingProjects && !error && projects.length === 0 && (
            <div className="flex items-center justify-center h-full">
              <div className="text-xs text-muted-foreground">{t('workspace.projectNotFound')}</div>
            </div>
          )}

          {!isLoadingProjects && !error && projects
            .filter((project) => project.fullPath.toLowerCase().includes(searchKeyword.toLowerCase()))
            .map((project) => {
            const state = projectStates[project.encodedPath] || { isExpanded: false, isLoading: false, sessions: [], error: null };

            return (
              <div key={project.encodedPath} className="mb-3">
                {/* Project Header (Clickable) */}
                <button
                  onClick={() => toggleProject(project.encodedPath)}
                  className="w-full flex items-center gap-2 p-2 rounded hover:bg-accent transition-colors text-left"
                >
                  {/* Expand/Collapse Icon */}
                  <svg
                    className={`w-3 h-3 text-muted-foreground transition-transform ${state.isExpanded ? 'rotate-90' : ''}`}
                    fill="none"
                    stroke="currentColor"
                    viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                  </svg>

                  {/* Folder Icon */}
                  <svg className="w-4 h-4 text-muted-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                  </svg>

                  {/* Project Path */}
                  <span className="flex-1 text-xs font-medium text-foreground truncate" title={project.fullPath}>
                    {project.fullPath}
                  </span>

                  {/* Session Count */}
                  <span className="text-xs text-muted-foreground">
                    ({project.sessionCount})
                  </span>
                </button>

                {/* Sessions (when expanded) */}
                {state.isExpanded && (
                  <div className="ml-6 mt-2">
                    {state.isLoading && (
                      <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                        <svg className="animate-spin h-3 w-3" fill="none" viewBox="0 0 24 24">
                          <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                          <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                        </svg>
                        <span>{t('sessions.loadingSessions')}</span>
                      </div>
                    )}

                    {state.error && (
                      <div className="p-3 text-xs text-red-11">{state.error}</div>
                    )}

                    {!state.isLoading && !state.error && (
                      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
                        {state.sessions.map((session) => (
                          <div
                            key={session.path}
                            onClick={() => handleSessionClick(project.fullPath, session.path)}
                            className="p-3 bg-secondary rounded border border-border hover:border-brand hover:shadow-md cursor-pointer transition-all"
                          >
                            {/* Session Title + Engine Badge */}
                            <div className="flex items-center gap-1.5 mb-1">
                              {session.engine && session.engine !== 'claude' && (
                                <span className={`shrink-0 px-1 py-0.5 text-[10px] leading-none font-medium rounded ${
                                  session.engine === 'ollama' ? 'bg-blue-500/15 text-blue-11' :
                                  session.engine === 'codex' ? 'bg-green-500/15 text-green-11' :
                                  session.engine === 'kimi' ? 'bg-purple-500/15 text-purple-11' :
                                  'bg-muted text-muted-foreground'
                                }`}>
                                  {session.engine}
                                </span>
                              )}
                              <h4 className="text-xs font-medium text-foreground truncate" title={session.title}>
                                {session.title}
                              </h4>
                            </div>

                            {/* Session Time */}
                            <div className="text-xs text-muted-foreground mb-2">
                              {formatDate(session.modifiedAt)}
                            </div>

                            {/* Messages Preview */}
                            <div className="space-y-0.5 text-xs">
                              {/* First Messages */}
                              {session.firstMessages.map((msg, idx) => (
                                <div
                                  key={`first-${idx}`}
                                  className="text-foreground truncate"
                                  title={msg}
                                >
                                  <span className="text-slate-9 mr-1">•</span>
                                  {msg}
                                </div>
                              ))}

                              {/* Separator if there are last messages */}
                              {session.lastMessages.length > 0 && (
                                <div className="text-slate-9 text-center py-0.5">
                                  ···
                                </div>
                              )}

                              {/* Last Messages */}
                              {session.lastMessages.map((msg, idx) => (
                                <div
                                  key={`last-${idx}`}
                                  className="text-foreground truncate"
                                  title={msg}
                                >
                                  <span className="text-slate-9 mr-1">•</span>
                                  {msg}
                                </div>
                              ))}
                            </div>
                          </div>
                        ))}
                      </div>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
