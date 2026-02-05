'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

interface SessionInfo {
  path: string;
  title: string;
  modifiedAt: string;
  firstMessages: string[];
  lastMessages: string[];
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

interface EmptyStateProps {
  onSelectSession: (cwd: string, sessionId: string) => void;
}

export function EmptyState({ onSelectSession }: EmptyStateProps) {
  const [projects, setProjects] = useState<ProjectInfo[]>([]);
  const [projectStates, setProjectStates] = useState<Record<string, ProjectState>>({});
  const [isLoadingProjects, setIsLoadingProjects] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const searchInputRef = useRef<HTMLInputElement>(null);

  // 加载项目列表
  const loadProjects = useCallback(async () => {
    setIsLoadingProjects(true);
    setError(null);
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

  // 加载某个项目的 session 列表
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

  // 切换项目展开/折叠状态
  const toggleProject = useCallback((encodedPath: string) => {
    const currentState = projectStates[encodedPath];

    if (currentState?.isExpanded) {
      setProjectStates(prev => ({
        ...prev,
        [encodedPath]: {
          ...prev[encodedPath],
          isExpanded: false,
        },
      }));
    } else {
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
    loadProjects();
    setTimeout(() => {
      searchInputRef.current?.focus();
    }, 100);
  }, [loadProjects]);

  const handleSessionClick = (cwd: string, sessionPath: string) => {
    const fileName = sessionPath.split('/').pop() || '';
    const sessionId = fileName.replace('.jsonl', '');
    onSelectSession(cwd, sessionId);
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

  return (
    <div className="flex-1 flex flex-col bg-card">
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-border">
        <h2 className="text-lg font-medium text-foreground">
          选择一个项目开始
        </h2>
        <input
          ref={searchInputRef}
          type="text"
          placeholder="搜索项目路径..."
          value={searchKeyword}
          onChange={(e) => setSearchKeyword(e.target.value)}
          className="px-3 py-1.5 text-sm border border-border rounded-lg bg-card text-foreground placeholder-muted-foreground focus:outline-none focus:ring-2 focus:ring-ring focus:border-transparent"
        />
      </div>

      {/* Content */}
      <div className="flex-1 overflow-y-auto p-6">
        {isLoadingProjects && (
          <div className="flex items-center justify-center h-64">
            <div className="flex items-center gap-2 text-sm text-muted-foreground">
              <svg className="animate-spin h-5 w-5" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
              </svg>
              <span>加载项目中...</span>
            </div>
          </div>
        )}

        {error && (
          <div className="flex items-center justify-center h-64">
            <div className="text-sm text-red-500">{error}</div>
          </div>
        )}

        {!isLoadingProjects && !error && projects.length === 0 && (
          <div className="flex items-center justify-center h-64">
            <div className="text-sm text-muted-foreground">未找到项目</div>
          </div>
        )}

        {!isLoadingProjects && !error && (
          <div className="space-y-2">
            {projects
              .filter((project) => project.fullPath.toLowerCase().includes(searchKeyword.toLowerCase()))
              .map((project) => {
                const state = projectStates[project.encodedPath] || { isExpanded: false, isLoading: false, sessions: [], error: null };

                return (
                  <div key={project.encodedPath} className="border border-border rounded-lg overflow-hidden">
                    {/* Project Header */}
                    <button
                      onClick={() => toggleProject(project.encodedPath)}
                      className="w-full flex items-center gap-3 p-3 hover:bg-accent transition-colors text-left"
                    >
                      <svg
                        className={`w-4 h-4 text-muted-foreground transition-transform ${state.isExpanded ? 'rotate-90' : ''}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 5l7 7-7 7" />
                      </svg>
                      <svg className="w-5 h-5 text-brand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z" />
                      </svg>
                      <div className="flex-1 min-w-0">
                        <div className="text-sm font-medium text-foreground truncate">{project.name}</div>
                        <div className="text-xs text-muted-foreground truncate">{project.fullPath}</div>
                      </div>
                      <span className="text-xs text-muted-foreground bg-secondary px-2 py-0.5 rounded">
                        {project.sessionCount} 会话
                      </span>
                    </button>

                    {/* Sessions List */}
                    {state.isExpanded && (
                      <div className="border-t border-border bg-secondary/30">
                        {state.isLoading && (
                          <div className="flex items-center gap-2 p-3 text-xs text-muted-foreground">
                            <svg className="animate-spin h-4 w-4" fill="none" viewBox="0 0 24 24">
                              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" />
                              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4z" />
                            </svg>
                            <span>加载会话...</span>
                          </div>
                        )}

                        {state.error && (
                          <div className="p-3 text-xs text-red-500">{state.error}</div>
                        )}

                        {!state.isLoading && !state.error && state.sessions.length === 0 && (
                          <div className="p-3 text-xs text-muted-foreground">无会话记录</div>
                        )}

                        {!state.isLoading && !state.error && state.sessions.map((session) => (
                          <button
                            key={session.path}
                            onClick={() => handleSessionClick(project.fullPath, session.path)}
                            className="w-full flex items-start gap-3 p-3 hover:bg-accent transition-colors text-left border-t border-border first:border-t-0"
                          >
                            <svg className="w-4 h-4 text-muted-foreground mt-0.5 flex-shrink-0" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M8 12h.01M12 12h.01M16 12h.01M21 12c0 4.418-4.03 8-9 8a9.863 9.863 0 01-4.255-.949L3 20l1.395-3.72C3.512 15.042 3 13.574 3 12c0-4.418 4.03-8 9-8s9 3.582 9 8z" />
                            </svg>
                            <div className="flex-1 min-w-0">
                              <div className="text-sm text-foreground truncate">{session.title}</div>
                              <div className="text-xs text-muted-foreground mt-0.5">
                                {formatDate(session.modifiedAt)}
                              </div>
                              {session.firstMessages.length > 0 && (
                                <div className="text-xs text-muted-foreground mt-1 truncate">
                                  {session.firstMessages[0]}
                                </div>
                              )}
                            </div>
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                );
              })}
          </div>
        )}
      </div>
    </div>
  );
}
