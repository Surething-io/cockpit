'use client';

import { useState, useEffect, useCallback, useRef } from 'react';

// ============================================
// Types
// ============================================

interface RunningService {
  id: string;
  cwd: string;
  command: string;
  pid: number;
  startedAt: number;
  url?: string;
  logFile: string;
}

interface ServicesConfig {
  customCommands: string[];
}

interface PackageScripts {
  [key: string]: string;
}

interface ServicePanelProps {
  isOpen: boolean;
  onClose: () => void;
  initialCwd?: string;
  onOpenBrowser?: (url: string) => void;
}

// ============================================
// ServicePanel Component
// ============================================

export function ServicePanel({ isOpen, onClose, initialCwd, onOpenBrowser }: ServicePanelProps) {
  const [services, setServices] = useState<RunningService[]>([]);
  const [customCommands, setCustomCommands] = useState<string[]>([]);
  const [packageScripts, setPackageScripts] = useState<PackageScripts>({});
  const [selectedCwd, setSelectedCwd] = useState<string>(initialCwd || '');
  const [allProjects, setAllProjects] = useState<string[]>([]);
  const [isAddingCommand, setIsAddingCommand] = useState(false);
  const [newCommand, setNewCommand] = useState('');
  const [viewingLog, setViewingLog] = useState<{ id: string; cwd: string; command: string } | null>(null);
  const newCommandInputRef = useRef<HTMLInputElement>(null);

  // 加载全局运行状态（每3秒轮询）
  const loadServices = useCallback(async () => {
    try {
      const res = await fetch('/api/services/status');
      if (res.ok) {
        const data = await res.json();
        setServices(data);

        // 收集所有项目路径
        const projects = [...new Set(data.map((s: RunningService) => s.cwd))] as string[];
        setAllProjects(projects);
      }
    } catch (error) {
      console.error('Failed to load services:', error);
    }
  }, []);

  // 加载当前项目的配置
  const loadConfig = useCallback(async (cwd: string) => {
    if (!cwd) return;

    try {
      const res = await fetch(`/api/services/config?cwd=${encodeURIComponent(cwd)}`);
      if (res.ok) {
        const data: ServicesConfig = await res.json();
        setCustomCommands(data.customCommands || []);
      }
    } catch (error) {
      console.error('Failed to load config:', error);
    }
  }, []);

  // 加载 package.json scripts
  const loadScripts = useCallback(async (cwd: string) => {
    if (!cwd) return;

    try {
      const res = await fetch(`/api/services/scripts?cwd=${encodeURIComponent(cwd)}`);
      if (res.ok) {
        const data = await res.json();
        setPackageScripts(data.scripts || {});
      }
    } catch (error) {
      console.error('Failed to load scripts:', error);
    }
  }, []);

  // 初始加载
  useEffect(() => {
    if (isOpen) {
      loadServices();
      if (selectedCwd) {
        loadConfig(selectedCwd);
        loadScripts(selectedCwd);
      }
    }
  }, [isOpen, selectedCwd, loadServices, loadConfig, loadScripts]);

  // 轮询运行状态（每3秒）
  useEffect(() => {
    if (!isOpen) return;

    const timer = setInterval(() => {
      loadServices();
    }, 3000);

    return () => clearInterval(timer);
  }, [isOpen, loadServices]);

  // 项目切换
  useEffect(() => {
    if (initialCwd && initialCwd !== selectedCwd) {
      setSelectedCwd(initialCwd);
    }
  }, [initialCwd, selectedCwd]);

  // 启动服务
  const handleStart = useCallback(async (command: string) => {
    if (!selectedCwd) return;

    try {
      const res = await fetch('/api/services/start', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selectedCwd, command }),
      });

      if (res.ok) {
        await loadServices();
      } else {
        const error = await res.json();
        alert(`Failed to start service: ${error.error}`);
      }
    } catch (error) {
      console.error('Failed to start service:', error);
      alert('Failed to start service');
    }
  }, [selectedCwd, loadServices]);

  // 停止服务
  const handleStop = useCallback(async (id: string) => {
    try {
      const res = await fetch('/api/services/stop', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id }),
      });

      if (res.ok) {
        await loadServices();
      } else {
        const error = await res.json();
        alert(`Failed to stop service: ${error.error}`);
      }
    } catch (error) {
      console.error('Failed to stop service:', error);
      alert('Failed to stop service');
    }
  }, [loadServices]);

  // 添加自定义命令
  const handleAddCommand = useCallback(async () => {
    if (!newCommand.trim() || !selectedCwd) return;

    const updatedCommands = [...customCommands, newCommand.trim()];
    setCustomCommands(updatedCommands);

    try {
      await fetch('/api/services/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selectedCwd, customCommands: updatedCommands }),
      });
    } catch (error) {
      console.error('Failed to save config:', error);
    }

    setNewCommand('');
    setIsAddingCommand(false);
  }, [newCommand, selectedCwd, customCommands]);

  // 删除自定义命令
  const handleDeleteCommand = useCallback(async (command: string) => {
    if (!selectedCwd) return;

    const updatedCommands = customCommands.filter(c => c !== command);
    setCustomCommands(updatedCommands);

    try {
      await fetch('/api/services/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cwd: selectedCwd, customCommands: updatedCommands }),
      });
    } catch (error) {
      console.error('Failed to save config:', error);
    }
  }, [selectedCwd, customCommands]);

  // 获取当前项目的运行服务
  const currentServices = services.filter(s => s.cwd === selectedCwd);

  // 检查命令是否正在运行
  const isCommandRunning = useCallback((command: string) => {
    return currentServices.some(s => s.command === command);
  }, [currentServices]);

  // 获取命令对应的服务
  const getServiceByCommand = useCallback((command: string) => {
    return currentServices.find(s => s.command === command);
  }, [currentServices]);

  // Auto focus 添加命令输入框
  useEffect(() => {
    if (isAddingCommand) {
      newCommandInputRef.current?.focus();
    }
  }, [isAddingCommand]);

  if (!isOpen) return null;

  return (
    <>
      {/* Modal */}
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        {/* Backdrop */}
        <div
          className="absolute inset-0 bg-black/50 backdrop-blur-sm"
          onClick={onClose}
        />

        {/* Panel */}
        <div className="relative w-full max-w-6xl h-[90vh] mx-4 bg-card rounded-lg shadow-xl flex flex-col overflow-hidden">
          {/* Header */}
          <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
            <h2 className="text-sm font-medium text-foreground">后台服务</h2>
            <div className="flex items-center gap-3">
              {/* 项目选择 */}
              {allProjects.length > 1 && (
                <select
                  value={selectedCwd}
                  onChange={(e) => setSelectedCwd(e.target.value)}
                  className="px-2 py-1 text-xs border border-border rounded bg-card text-foreground focus:outline-none focus:ring-2 focus:ring-ring"
                >
                  {allProjects.map((cwd) => (
                    <option key={cwd} value={cwd}>
                      {cwd.split('/').pop() || cwd}
                    </option>
                  ))}
                  {initialCwd && !allProjects.includes(initialCwd) && (
                    <option value={initialCwd}>
                      {initialCwd.split('/').pop() || initialCwd}
                    </option>
                  )}
                </select>
              )}

              {/* 关闭按钮 */}
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
            {!selectedCwd ? (
              <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
                请选择一个项目
              </div>
            ) : (
              <div className="space-y-6">
                {/* 自定义命令 */}
                <div>
                  <div className="flex items-center justify-between mb-3">
                    <h3 className="text-sm font-medium text-foreground">自定义命令</h3>
                    <button
                      onClick={() => setIsAddingCommand(true)}
                      className="p-1 text-brand hover:text-brand/80 transition-colors"
                      title="添加命令"
                    >
                      <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 4v16m8-8H4" />
                      </svg>
                    </button>
                  </div>

                  <div className="space-y-2">
                    {/* 添加命令输入框 */}
                    {isAddingCommand && (
                      <div className="flex items-center gap-2 p-3 bg-secondary/50 border border-border rounded-lg">
                        <input
                          ref={newCommandInputRef}
                          type="text"
                          value={newCommand}
                          onChange={(e) => setNewCommand(e.target.value)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter') {
                              handleAddCommand();
                            } else if (e.key === 'Escape') {
                              setIsAddingCommand(false);
                              setNewCommand('');
                            }
                          }}
                          placeholder="输入命令，Enter 添加..."
                          className="flex-1 px-2 py-1 text-sm bg-card border border-border rounded focus:outline-none focus:ring-2 focus:ring-ring"
                        />
                        <button
                          onClick={handleAddCommand}
                          disabled={!newCommand.trim()}
                          className="px-2 py-1 text-xs bg-brand text-white rounded hover:bg-brand/90 disabled:opacity-50 disabled:cursor-not-allowed"
                        >
                          添加
                        </button>
                        <button
                          onClick={() => {
                            setIsAddingCommand(false);
                            setNewCommand('');
                          }}
                          className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                        >
                          取消
                        </button>
                      </div>
                    )}

                    {/* 自定义命令列表 */}
                    {customCommands.map((command) => {
                      const service = getServiceByCommand(command);
                      const running = !!service;

                      return (
                        <div
                          key={command}
                          className="flex items-center gap-3 p-3 bg-secondary/50 border border-border rounded-lg hover:bg-secondary/70 transition-colors"
                        >
                          {/* 状态指示器 */}
                          <div className={`w-2 h-2 rounded-full flex-shrink-0 ${running ? 'bg-green-9' : 'bg-slate-7'}`} />

                          {/* 命令 */}
                          <div className="flex-1 min-w-0">
                            <div className="text-sm font-mono text-foreground truncate">{command}</div>
                            {service?.url && (
                              <button
                                onClick={() => onOpenBrowser?.(service.url!)}
                                className="text-xs text-brand hover:underline mt-0.5"
                              >
                                {service.url}
                              </button>
                            )}
                          </div>

                          {/* 操作按钮 */}
                          <div className="flex items-center gap-1 flex-shrink-0">
                            <button
                              onClick={() => setViewingLog({
                                id: service?.id || '',
                                cwd: selectedCwd,
                                command
                              })}
                              className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                            >
                              日志
                            </button>
                            {running && service ? (
                              <button
                                onClick={() => handleStop(service.id)}
                                className="px-2 py-1 text-xs bg-red-9/20 text-red-11 rounded hover:bg-red-9/30"
                              >
                                停止
                              </button>
                            ) : (
                              <button
                                onClick={() => handleStart(command)}
                                className="px-2 py-1 text-xs bg-green-9/20 text-green-11 rounded hover:bg-green-9/30"
                              >
                                启动
                              </button>
                            )}
                            <button
                              onClick={() => handleDeleteCommand(command)}
                              disabled={running}
                              className="p-1 text-red-9 hover:text-red-10 disabled:opacity-50 disabled:cursor-not-allowed"
                              title="删除命令"
                            >
                              <svg className="w-4 h-4" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16" />
                              </svg>
                            </button>
                          </div>
                        </div>
                      );
                    })}

                    {customCommands.length === 0 && !isAddingCommand && (
                      <div className="text-xs text-muted-foreground text-center py-4">
                        暂无自定义命令
                      </div>
                    )}
                  </div>
                </div>

                {/* package.json scripts */}
                {Object.keys(packageScripts).length > 0 && (
                  <div>
                    <h3 className="text-sm font-medium text-foreground mb-3">package.json scripts</h3>
                    <div className="space-y-2">
                      {Object.entries(packageScripts).map(([scriptName, scriptCommand]) => {
                        const fullCommand = `npm run ${scriptName}`;
                        const service = getServiceByCommand(fullCommand);
                        const running = !!service;

                        return (
                          <div
                            key={scriptName}
                            className="flex items-center gap-3 p-3 bg-secondary/50 border border-border rounded-lg hover:bg-secondary/70 transition-colors"
                          >
                            {/* 状态指示器 */}
                            <div className={`w-2 h-2 rounded-full flex-shrink-0 ${running ? 'bg-green-9' : 'bg-slate-7'}`} />

                            {/* 脚本信息 */}
                            <div className="flex-1 min-w-0">
                              <div className="text-sm font-medium text-foreground">{scriptName}</div>
                              <div className="text-xs font-mono text-muted-foreground truncate">{fullCommand}</div>
                              {service?.url && (
                                <button
                                  onClick={() => onOpenBrowser?.(service.url!)}
                                  className="text-xs text-brand hover:underline mt-0.5"
                                >
                                  {service.url}
                                </button>
                              )}
                            </div>

                            {/* 操作按钮 */}
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                onClick={() => setViewingLog({
                                  id: service?.id || '',
                                  cwd: selectedCwd,
                                  command: fullCommand
                                })}
                                className="px-2 py-1 text-xs text-muted-foreground hover:text-foreground"
                              >
                                日志
                              </button>
                              {running && service ? (
                                <button
                                  onClick={() => handleStop(service.id)}
                                  className="px-2 py-1 text-xs bg-red-9/20 text-red-11 rounded hover:bg-red-9/30"
                                >
                                  停止
                                </button>
                              ) : (
                                <button
                                  onClick={() => handleStart(fullCommand)}
                                  className="px-2 py-1 text-xs bg-green-9/20 text-green-11 rounded hover:bg-green-9/30"
                                >
                                  启动
                                </button>
                              )}
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      </div>

      {/* 日志查看 Modal */}
      {viewingLog && (
        <LogViewerModal
          serviceId={viewingLog.id}
          cwd={viewingLog.cwd}
          command={viewingLog.command}
          onClose={() => setViewingLog(null)}
        />
      )}
    </>
  );
}

// ============================================
// LogViewerModal Component
// ============================================

interface LogViewerModalProps {
  serviceId: string;
  cwd: string;
  command: string;
  onClose: () => void;
}

function LogViewerModal({ serviceId, cwd, command, onClose }: LogViewerModalProps) {
  const [logContent, setLogContent] = useState('');
  const [isLoading, setIsLoading] = useState(true);
  const logContainerRef = useRef<HTMLDivElement>(null);

  const loadLog = useCallback(async () => {
    setIsLoading(true);
    try {
      // 构建查询参数，同时传递 id, cwd, command 以支持历史日志查看
      const params = new URLSearchParams();
      if (serviceId) params.set('id', serviceId);
      params.set('cwd', cwd);
      params.set('command', command);

      const res = await fetch(`/api/services/log?${params.toString()}`);
      if (res.ok) {
        const data = await res.json();
        setLogContent(data.content || '');
      }
    } catch (error) {
      console.error('Failed to load log:', error);
    } finally {
      setIsLoading(false);
    }
  }, [serviceId, cwd, command]);

  useEffect(() => {
    loadLog();
    // 每2秒刷新日志
    const timer = setInterval(loadLog, 2000);
    return () => clearInterval(timer);
  }, [loadLog]);

  // Auto scroll to bottom when log content changes
  useEffect(() => {
    if (logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [logContent]);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center">
      {/* Backdrop */}
      <div
        className="absolute inset-0 bg-black/50 backdrop-blur-sm"
        onClick={onClose}
      />

      {/* Modal */}
      <div className="relative w-full max-w-4xl h-[80vh] mx-4 bg-card rounded-lg shadow-xl flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-4 py-3 border-b border-border flex-shrink-0">
          <h3 className="text-sm font-medium text-foreground">服务日志</h3>
          <button
            onClick={onClose}
            className="p-1 text-slate-9 hover:text-foreground hover:bg-accent rounded transition-colors"
          >
            <svg className="w-5 h-5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M6 18L18 6M6 6l12 12" />
            </svg>
          </button>
        </div>

        {/* Log Content */}
        <div
          ref={logContainerRef}
          className="flex-1 overflow-y-auto p-4 bg-black/90 font-mono text-xs text-green-11"
        >
          {isLoading && !logContent ? (
            <div className="flex items-center justify-center h-full">
              <span className="text-muted-foreground">加载中...</span>
            </div>
          ) : (
            <pre className="whitespace-pre-wrap break-all">{logContent || '暂无日志'}</pre>
          )}
        </div>
      </div>
    </div>
  );
}
